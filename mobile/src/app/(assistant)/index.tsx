import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { API_URL } from '@/config/api';
import { getAccessToken } from '@/lib/api';

interface SeedZone {
  id: number;
  name: string;
  priceCents: number;
  available: number;
}

interface SeedEvent {
  id: number;
  name: string;
  venue: string;
  date: string;
  zones: SeedZone[];
}

interface ReservationResponse {
  reservaId: number;
  expiraEn: string;
  zonaId: number;
}

const SEED_EVENTS: SeedEvent[] = [
  {
    id: 6,
    name: 'Expo Tech Panama',
    venue: 'Estadio Rommel Fernandez',
    date: '2026-11-07T14:00:00Z',
    zones: [
      { id: 13, name: 'Pase dia', priceCents: 2000, available: 367 },
      { id: 14, name: 'Pase completo', priceCents: 4500, available: 158 },
    ],
  },
  {
    id: 7,
    name: 'Concierto de Fin de Ano',
    venue: 'Teatro Nacional',
    date: '2026-12-12T01:00:00Z',
    zones: [
      { id: 15, name: 'General', priceCents: 5000, available: 785 },
      { id: 16, name: 'VIP', priceCents: 13000, available: 130 },
    ],
  },
];

const HOLD_DURATION_SECONDS = 10 * 60;

function formatPrice(priceCents: number) {
  return `$${(priceCents / 100).toFixed(2)}`;
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function formatEventDate(date: string) {
  return new Date(date).toLocaleString('es-PA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function responseError(response: Response) {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
    ) {
      return body.message;
    }
  } catch {
    // The server may return an empty body for errors such as HTTP 204.
  }
  return `La solicitud falló (HTTP ${response.status}).`;
}

export default function AssistantEventsScreen() {
  const [selectedEvent, setSelectedEvent] = useState<SeedEvent | null>(null);
  const [reservation, setReservation] = useState<ReservationResponse | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [loadingZoneId, setLoadingZoneId] = useState<number | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [error, setError] = useState('');

  const selectedZone = useMemo(
    () => selectedEvent?.zones.find((zone) => zone.id === reservation?.zonaId) ?? null,
    [reservation?.zonaId, selectedEvent],
  );

  useEffect(() => {
    if (!selectedEvent) return;

    if (reservation) {
      const updateCountdown = () => {
        const remaining = Math.max(
          0,
          Math.ceil((Date.parse(reservation.expiraEn) - Date.now()) / 1000),
        );
        setSecondsLeft(remaining);
      };

      updateCountdown();
      const interval = setInterval(updateCountdown, 1000);
      return () => clearInterval(interval);
    }

    const interval = setInterval(() => {
      setSecondsLeft((remaining) => Math.max(0, remaining - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [reservation, selectedEvent]);

  const reserveZone = async (zone: SeedZone) => {
    if (loadingZoneId !== null) return;
    setError('');
    setLoadingZoneId(zone.id);

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        router.replace('/(auth)/login');
        return;
      }

      const response = await fetch(`${API_URL}/reservas`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': Crypto.randomUUID(),
        },
        body: JSON.stringify({ zonaId: zone.id, cantidad: 1 }),
      });
      if (!response.ok) {
        throw new Error(await responseError(response));
      }

      const result: unknown = await response.json();
      if (
        typeof result !== 'object' ||
        result === null ||
        !('reservaId' in result) ||
        typeof result.reservaId !== 'number' ||
        !('expiraEn' in result) ||
        typeof result.expiraEn !== 'string' ||
        !Number.isFinite(Date.parse(result.expiraEn))
      ) {
        throw new Error('El backend devolvió una reserva con formato inválido.');
      }

      setReservation({
        reservaId: result.reservaId,
        expiraEn: result.expiraEn,
        zonaId: zone.id,
      });
    } catch (reserveError) {
      setError(
        reserveError instanceof Error
          ? reserveError.message
          : 'No se pudo crear la reserva temporal.',
      );
    } finally {
      setLoadingZoneId(null);
    }
  };

  const proceedToPayment = async () => {
    if (!reservation || secondsLeft === 0 || isPaying) return;
    setError('');
    setIsPaying(true);

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        router.replace('/(auth)/login');
        return;
      }

      const response = await fetch(`${API_URL}/reservas/${reservation.reservaId}/pago`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': Crypto.randomUUID(),
        },
      });
      if (!response.ok) {
        throw new Error(await responseError(response));
      }

      setReservation(null);
      Alert.alert('Compra completada', 'Tu entrada ya está disponible en la billetera.', [
        {
          text: 'Ver billetera',
          onPress: () => router.replace('/(assistant)/wallet'),
        },
      ]);
    } catch (paymentError) {
      setError(
        paymentError instanceof Error
          ? paymentError.message
          : 'No se pudo completar el pago.',
      );
    } finally {
      setIsPaying(false);
    }
  };

  const cancelReservation = async () => {
    if (!reservation) return;
    setError('');
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        router.replace('/(auth)/login');
        return;
      }

      const response = await fetch(`${API_URL}/reservas/${reservation.reservaId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      setReservation(null);
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : 'No se pudo cancelar la reserva.',
      );
    }
  };

  const closeEventDetails = async () => {
    if (reservation) {
      await cancelReservation();
      return;
    }
    setSelectedEvent(null);
    setError('');
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>TIXFLOW · ASISTENTE</Text>
            <Text style={styles.title}>Cartelera</Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={reservation !== null || loadingZoneId !== null || isPaying}
            onPress={() => router.replace('/(assistant)/wallet')}>
            <Text style={styles.link}>Mi billetera</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.intro}>
          Descubre eventos y reserva tu lugar antes de pagar.
        </Text>
        <Text style={styles.seedNotice}>
          Eventos y disponibilidad de muestra basados en el seed. El backend confirma el cupo al reservar.
        </Text>

        {SEED_EVENTS.map((event) => (
          <TouchableOpacity
            key={event.id}
            accessibilityRole="button"
            style={styles.eventCard}
            disabled={reservation !== null || loadingZoneId !== null || isPaying}
            onPress={() => {
              setSelectedEvent(event);
              setReservation(null);
              setSecondsLeft(HOLD_DURATION_SECONDS);
              setError('');
            }}>
            <Text style={styles.eventEyebrow}>PROXIMAMENTE</Text>
            <Text style={styles.eventTitle}>{event.name}</Text>
            <Text style={styles.eventMeta}>{event.venue}</Text>
            <Text style={styles.eventMeta}>{formatEventDate(event.date)}</Text>
            <Text style={styles.eventAction}>Ver zonas y reservar →</Text>
          </TouchableOpacity>
        ))}

        {selectedEvent ? (
          <View style={styles.purchasePanel}>
            <View style={styles.panelHeader}>
              <View style={styles.panelHeading}>
                <Text style={styles.eyebrow}>RESERVA DE ENTRADA</Text>
                <Text style={styles.panelTitle}>{selectedEvent.name}</Text>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={loadingZoneId !== null || isPaying}
                onPress={() => void closeEventDetails()}>
                <Text style={styles.link}>{reservation ? 'Cancelar' : 'Cerrar'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.eventMeta}>
              Elige una zona para mantener tu cupo durante 10 minutos.
            </Text>

            {selectedEvent.zones.map((zone) => (
              <View key={zone.id} style={styles.zoneCard}>
                <View style={styles.zoneDetails}>
                  <Text style={styles.zoneName}>{zone.name}</Text>
                  <Text style={styles.zoneAvailability}>
                    {zone.available} disponibles · {formatPrice(zone.priceCents)}
                  </Text>
                </View>
                {reservation?.zonaId === zone.id ? (
                  <Text style={styles.reservedLabel}>Reservada</Text>
                ) : (
                  <TouchableOpacity
                    accessibilityRole="button"
                    style={styles.reserveButton}
                    disabled={loadingZoneId !== null || reservation !== null}
                    onPress={() => void reserveZone(zone)}>
                    {loadingZoneId === zone.id ? (
                      <ActivityIndicator color="#092333" />
                    ) : (
                      <Text style={styles.reserveButtonText}>Reservar</Text>
                    )}
                  </TouchableOpacity>
                )}
              </View>
            ))}

            <View style={styles.holdPanel}>
              <Text style={styles.holdCaption}>
                {reservation ? 'TIEMPO RESTANTE DE TU RESERVA' : 'TIEMPO DE RESERVA TEMPORAL'}
              </Text>
              <Text style={[styles.countdown, secondsLeft === 0 && styles.expiredCountdown]}>
                {formatCountdown(secondsLeft)}
              </Text>
              {reservation ? (
                <>
                  <Text style={styles.eventMeta}>
                    {selectedZone
                      ? `${selectedZone.name} · ${formatPrice(selectedZone.priceCents)}`
                      : 'Tu cupo está reservado.'}
                  </Text>
                  {secondsLeft === 0 ? (
                    <>
                      <Text style={styles.expiredText}>
                        La reserva venció. Elige una zona para reservar de nuevo.
                      </Text>
                      <TouchableOpacity
                        accessibilityRole="button"
                        style={styles.payButton}
                        onPress={() => {
                          setReservation(null);
                          setSecondsLeft(HOLD_DURATION_SECONDS);
                        }}>
                        <Text style={styles.payButtonText}>Elegir otra zona</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[styles.payButton, isPaying && styles.disabledButton]}
                      disabled={isPaying}
                      onPress={() => void proceedToPayment()}>
                      {isPaying ? (
                        <ActivityIndicator color="#092333" />
                      ) : (
                        <Text style={styles.payButtonText}>Proceder al Pago</Text>
                      )}
                    </TouchableOpacity>
                  )}
                </>
              ) : (
                <Text style={styles.eventMeta}>
                  Selecciona una zona para confirmar la reserva temporal con el backend.
                </Text>
              )}
            </View>
          </View>
        ) : null}

        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#f4f8fa', flex: 1 },
  content: { padding: 20, paddingBottom: 40 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 18,
    marginTop: 12,
  },
  eyebrow: { color: '#12a99d', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: '#092333', fontSize: 30, fontWeight: '800', marginTop: 4 },
  link: { color: '#0b8f87', fontSize: 14, fontWeight: '700' },
  intro: { color: '#314b59', fontSize: 16, lineHeight: 23, marginBottom: 8 },
  seedNotice: { color: '#687b89', fontSize: 12, lineHeight: 18, marginBottom: 18 },
  eventCard: {
    backgroundColor: '#fff',
    borderColor: '#dfe8ed',
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
    padding: 18,
  },
  eventEyebrow: { color: '#0b8f87', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  eventTitle: { color: '#092333', fontSize: 20, fontWeight: '800', marginTop: 8 },
  eventMeta: { color: '#687b89', fontSize: 13, marginTop: 5 },
  eventAction: { color: '#0b8f87', fontSize: 14, fontWeight: '700', marginTop: 16 },
  purchasePanel: {
    backgroundColor: '#fff',
    borderColor: '#12c4b2',
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 12,
    padding: 18,
  },
  panelHeader: { alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'space-between' },
  panelHeading: { flex: 1, paddingRight: 12 },
  panelTitle: { color: '#092333', fontSize: 21, fontWeight: '800', marginTop: 5 },
  zoneCard: {
    alignItems: 'center',
    borderBottomColor: '#e5ecef',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 15,
  },
  zoneDetails: { flex: 1 },
  zoneName: { color: '#092333', fontSize: 15, fontWeight: '700' },
  zoneAvailability: { color: '#687b89', fontSize: 12, marginTop: 4 },
  reserveButton: {
    alignItems: 'center',
    backgroundColor: '#d5f5f0',
    borderRadius: 9,
    minWidth: 88,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  reserveButtonText: { color: '#092333', fontSize: 13, fontWeight: '800' },
  reservedLabel: { color: '#0b8f87', fontSize: 13, fontWeight: '800' },
  holdPanel: { alignItems: 'center', backgroundColor: '#f4f8fa', borderRadius: 13, marginTop: 18, padding: 16 },
  holdCaption: { color: '#687b89', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  countdown: { color: '#092333', fontSize: 38, fontWeight: '900', marginVertical: 3 },
  expiredCountdown: { color: '#b91c1c' },
  expiredText: { color: '#b91c1c', fontSize: 13, marginTop: 10, textAlign: 'center' },
  payButton: {
    alignItems: 'center',
    backgroundColor: '#12c4b2',
    borderRadius: 11,
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 14,
    width: '100%',
  },
  disabledButton: { opacity: 0.7 },
  payButtonText: { color: '#092333', fontSize: 15, fontWeight: '800' },
  error: { backgroundColor: '#fff3e8', borderRadius: 10, color: '#9a4b00', marginTop: 16, padding: 12 },
});
