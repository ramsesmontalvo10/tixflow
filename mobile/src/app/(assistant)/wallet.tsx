import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { router } from 'expo-router';
import { API_URL } from '@/config/api';
import { getAccessToken } from '@/lib/api';
import {
  RotatingToken,
  TOKEN_WINDOW_SECONDS,
} from '@/lib/rotating-token';

interface Ticket {
  id: number;
  eventoId: number;
  zonaId: number;
  estado: string;
}

type TicketStatus = 'pagada' | 'usada' | 'reembolsada' | 'transferida';

interface TokenBlockResponse {
  tokens: RotatingToken[];
}

const TICKET_STATUS_STYLES: Record<TicketStatus, { background: string; text: string }> = {
  pagada: { background: '#dcfce7', text: '#166534' },
  usada: { background: '#e5e7eb', text: '#4b5563' },
  reembolsada: { background: '#fee2e2', text: '#b91c1c' },
  transferida: { background: '#dbeafe', text: '#1d4ed8' },
};

const SEED_DEMO_TICKET: Ticket = {
  id: 3069,
  eventoId: 4,
  zonaId: 8,
  estado: 'pagada',
};

export default function WalletScreen() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [tokenBlock, setTokenBlock] = useState<RotatingToken[]>([]);
  const [clockSeconds, setClockSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [secondsLeft, setSecondsLeft] = useState(TOKEN_WINDOW_SECONDS);
  const [demoWindow, setDemoWindow] = useState(0);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [loadingToken, setLoadingToken] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [demoTokenMode, setDemoTokenMode] = useState(false);
  const [error, setError] = useState('');

  const loadTickets = useCallback(async () => {
    setLoadingTickets(true);
    setError('');
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error('No se encontró una sesión guardada.');
      }

      const response = await fetch(`${API_URL}/tickets/my`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`No se pudieron cargar las entradas (HTTP ${response.status}).`);
      }

      const result: Ticket[] = await response.json();
      if (!Array.isArray(result)) {
        throw new Error('El backend devolvió una lista de entradas inválida.');
      }
      setTickets(result);
      setDemoMode(false);
      setSelectedTicket((current) =>
        current
          ? result.find((ticket) => ticket.id === current.id) ?? result[0] ?? null
          : result[0] ?? null,
      );
    } catch (loadError) {
      setTickets([SEED_DEMO_TICKET]);
      setSelectedTicket(SEED_DEMO_TICKET);
      setDemoMode(true);
      setError(
        loadError instanceof Error
          ? `${loadError.message} Mostrando la entrada de demostración del seed.`
          : 'No se pudo conectar con el backend. Mostrando la entrada de demostración del seed.',
      );
    } finally {
      setLoadingTickets(false);
    }
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const loadTokenBlock = useCallback(async (ticketId: number) => {
    setLoadingToken(true);
    setError('');
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        if (demoMode) {
          setDemoTokenMode(true);
          return;
        }
        router.replace('/(auth)/login');
        return;
      }

      const response = await fetch(
        `${API_URL}/tickets/${ticketId}/rotating?count=100`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (response.status === 409) {
        setTokenBlock([]);
        setDemoTokenMode(false);
        setTickets((current) => current.filter((ticket) => ticket.id !== ticketId));
        setSelectedTicket((current) => current?.id === ticketId ? null : current);
        setError(
          `La entrada #${ticketId} ya no está activa y no puede generar nuevos códigos QR.`,
        );
        return;
      }
      if (!response.ok) {
        throw new Error(
          `No se pudo obtener el bloque firmado del ticket (HTTP ${response.status}).`,
        );
      }

      const result: TokenBlockResponse = await response.json();
      if (!Array.isArray(result.tokens) || result.tokens.length === 0) {
        throw new Error('El backend no devolvió tokens rotativos.');
      }
      setTokenBlock(result.tokens);
      setDemoTokenMode(false);
    } catch (loadError) {
      setTokenBlock([]);
      setDemoTokenMode(true);
      setError(
        loadError instanceof Error
          ? `${loadError.message} Se mostrará un QR simulado sin firma válida.`
          : 'No se pudo cargar el token firmado. Se mostrará un QR simulado sin firma válida.',
      );
    } finally {
      setLoadingToken(false);
    }
  }, [demoMode]);

  useEffect(() => {
    if (selectedTicket) {
      setTokenBlock([]);
      setDemoTokenMode(false);
      void loadTokenBlock(selectedTicket.id);
    }
  }, [loadTokenBlock, selectedTicket?.id]);

  useEffect(() => {
    const interval = setInterval(() => {
      setClockSeconds(Math.floor(Date.now() / 1000));
      setSecondsLeft((remaining) => {
        if (remaining > 1) return remaining - 1;

        if (remaining === 1) {
          setSecondsLeft(0);
          setDemoWindow((window) => window + 1);
          return 0;
        }

        return TOKEN_WINDOW_SECONDS;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [demoTokenMode, loadTokenBlock, selectedTicket?.id]);

  const currentToken = useMemo(() => {
    const currentWindow = Math.floor(clockSeconds / TOKEN_WINDOW_SECONDS);
    return tokenBlock.find((token) => token.window === currentWindow) ?? null;
  }, [clockSeconds, tokenBlock]);

  useEffect(() => {
    if (
      selectedTicket &&
      !loadingToken &&
      tokenBlock.length > 0 &&
      !currentToken
    ) {
      void loadTokenBlock(selectedTicket.id);
    }
  }, [currentToken, loadTokenBlock, loadingToken, selectedTicket, tokenBlock]);

  const qrValue = currentToken
    ? JSON.stringify({
        ticketId: currentToken.ticketId,
        eventId: currentToken.eventId,
        window: currentToken.window,
        signatureBase64: currentToken.signatureBase64,
      })
    : demoTokenMode && selectedTicket
      ? JSON.stringify({
          ticketId: selectedTicket.id,
          eventId: selectedTicket.eventoId,
          window: demoWindow,
          signatureBase64: `DEMO-NOT-A-SIGNATURE-${selectedTicket.id}-${demoWindow}`,
          demo: true,
        })
      : '';

  const renderTicket = ({ item }: { item: Ticket }) => (
    <TouchableOpacity
      accessibilityRole="button"
      style={[
        styles.ticketCard,
        selectedTicket?.id === item.id && styles.ticketCardSelected,
      ]}
      onPress={() => setSelectedTicket(item)}>
      <View style={styles.ticketInfo}>
        <Text style={styles.eventTitle}>
          {demoMode ? 'Expo Tech Panamá · Seed' : `Evento ${item.eventoId}`}
        </Text>
        <Text style={styles.zoneText}>
          Zona {item.zonaId} · Entrada #{item.id}
        </Text>
      </View>
      {(() => {
        const status = item.estado.trim().toLowerCase();
        const knownStatus = Object.hasOwn(TICKET_STATUS_STYLES, status)
          ? (status as TicketStatus)
          : null;
        const colors = knownStatus
          ? TICKET_STATUS_STYLES[knownStatus]
          : TICKET_STATUS_STYLES.usada;

        return (
          <View style={[styles.ticketStatusBadge, { backgroundColor: colors.background }]}>
            <Text style={[styles.ticketStatusText, { color: colors.text }]}>
              {knownStatus?.toUpperCase() ?? item.estado.toUpperCase()}
            </Text>
          </View>
        );
      })()}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>TIXFLOW · ASISTENTE</Text>
            <Text style={styles.title}>Mi billetera</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => router.replace('/(assistant)')}>
              <Text style={styles.link}>Cartelera</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => router.replace('/(auth)/login')}>
              <Text style={styles.link}>Salir</Text>
            </TouchableOpacity>
          </View>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {demoMode ? (
          <Text style={styles.demoNotice}>
            Modo demostración: esta entrada proviene del seed. Los QR simulados no tienen una firma válida.
          </Text>
        ) : null}

        <Text style={styles.sectionTitle}>Entradas disponibles</Text>
        {loadingTickets ? (
          <ActivityIndicator color="#12c4b2" style={styles.loader} />
        ) : tickets.length === 0 ? (
          <Text style={styles.emptyText}>No tienes entradas pagadas todavía.</Text>
        ) : (
          <FlatList
            data={tickets}
            keyExtractor={(ticket) => String(ticket.id)}
            renderItem={renderTicket}
            scrollEnabled={false}
          />
        )}

        {selectedTicket ? (
          <View style={styles.qrPanel}>
            <Text style={styles.sectionTitle}>Código de acceso rotativo</Text>
            <Text style={styles.qrSubtitle}>
              {demoTokenMode
                ? 'QR simulado para demostración: no sirve para acceder al evento.'
                : 'El QR contiene una firma del backend y cambia cada 30 segundos.'}
            </Text>
            <View style={styles.qrFrame}>
              {loadingToken && !demoTokenMode ? (
                <ActivityIndicator color="#092333" size="large" />
              ) : qrValue ? (
                <QRCode value={qrValue} size={220} />
              ) : (
                <Text style={styles.qrUnavailable}>
                  {demoTokenMode
                    ? 'No se pudo generar el QR simulado.'
                    : 'Conéctate a la API para obtener un código firmado.'}
                </Text>
              )}
            </View>
            <Text style={styles.countdown}>
              {secondsLeft}s <Text style={styles.countdownHint}>para el siguiente código</Text>
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f8fa' },
  content: { padding: 20, paddingBottom: 40 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
    marginTop: 12,
  },
  headerActions: { alignItems: 'flex-end', gap: 12 },
  eyebrow: { color: '#12a99d', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: '#092333', fontSize: 30, fontWeight: '800', marginTop: 4 },
  link: { color: '#0b8f87', fontSize: 15, fontWeight: '700' },
  sectionTitle: { color: '#092333', fontSize: 18, fontWeight: '800', marginBottom: 12 },
  error: {
    backgroundColor: '#fff3e8',
    borderRadius: 10,
    color: '#9a4b00',
    marginBottom: 12,
    padding: 12,
  },
  demoNotice: { color: '#6b7280', fontSize: 12, marginBottom: 16 },
  loader: { marginVertical: 24 },
  emptyText: { color: '#687b89', marginBottom: 20 },
  ticketCard: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderColor: '#dfe8ed',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    padding: 16,
  },
  ticketCardSelected: { borderColor: '#12c4b2', borderWidth: 2 },
  ticketInfo: { flex: 1 },
  eventTitle: { color: '#092333', fontSize: 15, fontWeight: '700' },
  zoneText: { color: '#687b89', fontSize: 13, marginTop: 5 },
  ticketStatusBadge: { borderRadius: 999, marginLeft: 8, paddingHorizontal: 10, paddingVertical: 6 },
  ticketStatusText: { fontSize: 10, fontWeight: '800' },
  qrPanel: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 18,
    marginTop: 22,
    padding: 20,
  },
  qrSubtitle: { color: '#687b89', fontSize: 13, marginBottom: 18, textAlign: 'center' },
  qrFrame: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderColor: '#e5ecef',
    borderRadius: 12,
    borderWidth: 1,
    height: 250,
    justifyContent: 'center',
    width: 250,
  },
  qrUnavailable: { color: '#687b89', padding: 24, textAlign: 'center' },
  countdown: { color: '#092333', fontSize: 22, fontWeight: '800', marginTop: 16 },
  countdownHint: { color: '#687b89', fontSize: 12, fontWeight: '400' },
});
