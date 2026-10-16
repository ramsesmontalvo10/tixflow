import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '@/config/api';
import { getAccessToken } from '@/lib/api';

const STAFF_GATE_KEY = 'ticketing.staffGate';

type StaffDoor = {
  id: number;
  nombre: string;
};

type StaffEvent = {
  id: number;
  nombre: string;
  fecha: string;
  estado: string;
  puertas: StaffDoor[];
};

type SelectedShift = {
  eventId: number;
  eventName: string;
  doorId: number;
  doorName: string;
  deviceId: number;
};

async function readError(response: Response) {
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
    return `La solicitud falló (HTTP ${response.status}).`;
  }
  return `La solicitud falló (HTTP ${response.status}).`;
}

export default function StaffShiftScreen() {
  const [events, setEvents] = useState<StaffEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [selectedDoorId, setSelectedDoorId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStartingShift, setIsStartingShift] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const loadAssignedEvents = async () => {
      try {
        const token = await getAccessToken();
        if (!token) {
          router.replace('/(auth)/login');
          return;
        }

        const response = await fetch(`${API_URL}/scanner/events`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }

        const result: unknown = await response.json();
        if (
          !Array.isArray(result) ||
          !result.every(
            (event) =>
              typeof event?.id === 'number' &&
              typeof event?.nombre === 'string' &&
              typeof event?.fecha === 'string' &&
              Array.isArray(event?.puertas) &&
              event.puertas.every(
                (door: unknown) =>
                  typeof door === 'object' &&
                  door !== null &&
                  'id' in door &&
                  typeof door.id === 'number' &&
                  'nombre' in door &&
                  typeof door.nombre === 'string',
              ),
          )
        ) {
          throw new Error('El backend devolvió una lista de turnos inválida.');
        }

        if (!cancelled) {
          setEvents(result as StaffEvent[]);
          setSelectedEventId(result[0]?.id ?? null);
          setSelectedDoorId(result[0]?.puertas[0]?.id ?? null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'No se pudieron cargar tus eventos asignados.',
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void loadAssignedEvents();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? null;
  const selectedDoor =
    selectedEvent?.puertas.find((door) => door.id === selectedDoorId) ?? null;

  const selectEvent = (event: StaffEvent) => {
    setSelectedEventId(event.id);
    setSelectedDoorId(event.puertas[0]?.id ?? null);
    setError('');
  };

  const startScanning = async () => {
    if (!selectedEvent || !selectedDoor || isStartingShift) return;

    setIsStartingShift(true);
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) {
        router.replace('/(auth)/login');
        return;
      }

      const response = await fetch(`${API_URL}/scanner/devices`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          eventoId: selectedEvent.id,
          puertaId: selectedDoor.id,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const result: unknown = await response.json();
      if (
        typeof result !== 'object' ||
        result === null ||
        !('deviceId' in result) ||
        typeof result.deviceId !== 'number'
      ) {
        throw new Error('El backend no devolvió el dispositivo registrado.');
      }

      const shift: SelectedShift = {
        eventId: selectedEvent.id,
        eventName: selectedEvent.nombre,
        doorId: selectedDoor.id,
        doorName: selectedDoor.nombre,
        deviceId: result.deviceId,
      };
      await SecureStore.setItemAsync(STAFF_GATE_KEY, JSON.stringify(shift));
      router.push('/(staff)/scanner');
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : 'No se pudo iniciar el turno de escaneo.',
      );
    } finally {
      setIsStartingShift(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>TIXFLOW · OPERACIONES</Text>
        <Text style={styles.title}>Inicio de turno</Text>
        <Text style={styles.subtitle}>
          Solo puedes seleccionar eventos asignados a tu cuenta. Las puertas disponibles pertenecen al evento elegido.
        </Text>

        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color="#12a99d" />
            <Text style={styles.loadingText}>Cargando tus eventos asignados…</Text>
          </View>
        ) : events.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No hay turnos disponibles</Text>
            <Text style={styles.emptyText}>
              Tu cuenta no tiene eventos asignados que puedan iniciar un turno de escaneo.
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Evento asignado</Text>
            {events.map((event) => {
              const isSelected = event.id === selectedEventId;
              const date = new Date(event.fecha);
              const formattedDate = Number.isNaN(date.getTime())
                ? event.fecha
                : date.toLocaleDateString();
              return (
                <TouchableOpacity
                  key={event.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  style={[styles.eventCard, isSelected && styles.eventCardSelected]}
                  onPress={() => selectEvent(event)}>
                  <Text style={styles.eventName}>{event.nombre}</Text>
                  <Text style={styles.eventDate}>{formattedDate}</Text>
                </TouchableOpacity>
              );
            })}

            <Text style={styles.sectionTitle}>Selecciona una puerta</Text>
            {selectedEvent?.puertas.length ? (
              selectedEvent.puertas.map((door) => {
                const isSelected = selectedDoorId === door.id;
                return (
                  <TouchableOpacity
                    key={door.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    style={[styles.gateOption, isSelected && styles.gateOptionSelected]}
                    onPress={() => {
                      setSelectedDoorId(door.id);
                      setError('');
                    }}>
                    <View style={[styles.radio, isSelected && styles.radioSelected]}>
                      {isSelected ? <View style={styles.radioDot} /> : null}
                    </View>
                    <View style={styles.gateDetails}>
                      <Text style={styles.gateName}>{door.nombre}</Text>
                      <Text style={styles.gateMetadata}>
                        {selectedEvent.nombre} · Puerta #{door.id}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })
            ) : (
              <Text style={styles.emptyText}>
                Este evento no tiene puertas configuradas. Contacta al organizador.
              </Text>
            )}
          </>
        )}

        {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          accessibilityRole="button"
          style={[styles.startButton, (!selectedEvent || !selectedDoor || isStartingShift) && styles.startButtonDisabled]}
          disabled={!selectedEvent || !selectedDoor || isStartingShift}
          onPress={() => void startScanning()}>
          {isStartingShift ? (
            <ActivityIndicator color="#092333" />
          ) : (
            <Text style={styles.startButtonText}>Iniciar escaneo</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#f4f8fa', flex: 1 },
  content: { padding: 22, paddingBottom: 40 },
  eyebrow: { color: '#12a99d', fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginTop: 20 },
  title: { color: '#092333', fontSize: 30, fontWeight: '800', marginTop: 6 },
  subtitle: { color: '#687b89', fontSize: 14, lineHeight: 21, marginTop: 10 },
  sectionTitle: { color: '#092333', fontSize: 17, fontWeight: '800', marginBottom: 10, marginTop: 26 },
  loading: { alignItems: 'center', marginTop: 45 },
  loadingText: { color: '#687b89', marginTop: 12 },
  eventCard: { backgroundColor: '#fff', borderColor: '#dfe8ed', borderRadius: 13, borderWidth: 1, marginBottom: 10, padding: 16 },
  eventCardSelected: { backgroundColor: '#e5f8f5', borderColor: '#12a99d', borderWidth: 2 },
  eventName: { color: '#092333', fontSize: 16, fontWeight: '800' },
  eventDate: { color: '#49716f', fontSize: 13, marginTop: 5 },
  emptyCard: { backgroundColor: '#fff', borderRadius: 13, marginTop: 28, padding: 18 },
  emptyTitle: { color: '#092333', fontSize: 16, fontWeight: '800' },
  emptyText: { color: '#687b89', fontSize: 14, lineHeight: 20, marginTop: 8 },
  gateOption: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderColor: '#dfe8ed',
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 10,
    padding: 15,
  },
  gateOptionSelected: { borderColor: '#12a99d', borderWidth: 2 },
  radio: { alignItems: 'center', borderColor: '#98aab3', borderRadius: 10, borderWidth: 2, height: 20, justifyContent: 'center', marginRight: 13, width: 20 },
  radioSelected: { borderColor: '#0b8f87' },
  radioDot: { backgroundColor: '#0b8f87', borderRadius: 5, height: 10, width: 10 },
  gateDetails: { flex: 1 },
  gateName: { color: '#092333', fontSize: 15, fontWeight: '700' },
  gateMetadata: { color: '#687b89', fontSize: 12, marginTop: 4 },
  error: { backgroundColor: '#fff3e8', borderRadius: 10, color: '#9a4b00', marginTop: 12, padding: 12 },
  startButton: { alignItems: 'center', backgroundColor: '#12c4b2', borderRadius: 12, marginTop: 22, padding: 16 },
  startButtonDisabled: { opacity: 0.5 },
  startButtonText: { color: '#092333', fontSize: 16, fontWeight: '800' },
});
