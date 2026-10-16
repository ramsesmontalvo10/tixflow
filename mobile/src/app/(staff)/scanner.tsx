import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { Buffer } from 'buffer';
import nacl from 'tweetnacl';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '@/config/api';
import { getAccessToken } from '@/lib/api';
import {
  decodeRotatingToken,
  TOKEN_WINDOW_SECONDS,
  verifyRotatingToken,
} from '@/lib/rotating-token';

const db = SQLite.openDatabaseSync('ticketing_offline.db');
const PUBLIC_KEY_OVERRIDE = process.env.EXPO_PUBLIC_ED25519_PUBLIC_KEY ?? '';

type ScanStatus = 'ready' | 'granted' | 'duplicate' | 'invalid';

type StaffShift = {
  eventId: number;
  eventName: string;
  doorId: number;
  doorName: string;
  deviceId: number;
};

type PendingScan = {
  clientScanId: string;
  entradaId: number;
  eventoId: number;
  puertaId: number;
  escaneadoEn: string;
  deviceId: number;
};

type ServerScanResult = {
  clientScanId: string;
  entradaId: number;
  resultado: string;
};

async function responseError(response: Response) {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
    ) {
      return `HTTP ${response.status}: ${body.message}`;
    }
  } catch {
    return `La solicitud falló (HTTP ${response.status}).`;
  }
  return `La solicitud falló (HTTP ${response.status}).`;
}

function verifyBase64Token(
  data: string,
  publicKeyBase64: string,
  expectedEventId: number,
): number | null {
  try {
    const decoded = Buffer.from(data, 'base64');
    if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) {
      return null;
    }

    const [entryIdText, eventIdText, timestampText, signatureBase64, ...extra] =
      decoded.toString('utf8').split(':');
    const entryId = Number(entryIdText);
    const eventId = Number(eventIdText);
    const timestamp = Number(timestampText);
    if (
      extra.length > 0 ||
      !Number.isSafeInteger(entryId) ||
      entryId <= 0 ||
      !Number.isSafeInteger(eventId) ||
      eventId !== expectedEventId ||
      !Number.isSafeInteger(timestamp) ||
      !signatureBase64
    ) {
      return null;
    }

    const timestampIsUnixSeconds = timestamp >= 1_000_000_000;
    const currentTime = timestampIsUnixSeconds
      ? Math.floor(Date.now() / 1000)
      : Math.floor(Date.now() / TOKEN_WINDOW_SECONDS);
    const tolerance = timestampIsUnixSeconds ? TOKEN_WINDOW_SECONDS : 1;
    if (Math.abs(timestamp - currentTime) > tolerance) return null;

    const publicKey = Buffer.from(publicKeyBase64, 'base64');
    const signature = Buffer.from(signatureBase64, 'base64');
    const payload = Buffer.from(`${entryId}:${eventId}:${timestamp}`, 'utf8');
    if (
      publicKey.length !== nacl.sign.publicKeyLength ||
      signature.length !== nacl.sign.signatureLength
    ) {
      return null;
    }

    return nacl.sign.detached.verify(
      new Uint8Array(payload),
      new Uint8Array(signature),
      new Uint8Array(publicKey),
    )
      ? entryId
      : null;
  } catch {
    return null;
  }
}

export default function ScannerScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [shift, setShift] = useState<StaffShift | null>(null);
  const [publicKey, setPublicKey] = useState('');
  const [keyMessage, setKeyMessage] = useState('Cargando clave pública…');
  const [scanStatus, setScanStatus] = useState<ScanStatus>('ready');
  const [resultMessage, setResultMessage] = useState('Apunta la cámara a un QR rotativo.');
  const [syncMessage, setSyncMessage] = useState('Preparando sincronización…');
  const [revocationsReady, setRevocationsReady] = useState(false);
  const syncing = React.useRef(false);

  const updatePendingCount = useCallback(() => {
    const result = db.getFirstSync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM offline_scans;',
    );
    setPendingCount(result?.count ?? 0);
  }, []);

  useEffect(() => {
    db.execSync(`
      CREATE TABLE IF NOT EXISTS scanner_config (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_entries (
        entradaId INTEGER PRIMARY KEY NOT NULL,
        firstScannedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS offline_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clientScanId TEXT NOT NULL UNIQUE,
        entradaId INTEGER NOT NULL,
        escaneadoEn TEXT NOT NULL,
        resultado TEXT NOT NULL,
        eventoId INTEGER,
        puertaId INTEGER,
        deviceId INTEGER
      );
      CREATE TABLE IF NOT EXISTS revoked_entries (
        eventId INTEGER NOT NULL,
        entradaId INTEGER NOT NULL,
        revokedAt TEXT NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (eventId, entradaId)
      );
    `);

    const offlineScanColumns = db.getAllSync<{ name: string }>(
      'PRAGMA table_info(offline_scans);',
    );
    if (!offlineScanColumns.some((column) => column.name === 'resultado')) {
      db.execSync(
        "ALTER TABLE offline_scans ADD COLUMN resultado TEXT NOT NULL DEFAULT 'ok';",
      );
    }
    if (!offlineScanColumns.some((column) => column.name === 'eventoId')) {
      db.execSync('ALTER TABLE offline_scans ADD COLUMN eventoId INTEGER;');
    }
    if (!offlineScanColumns.some((column) => column.name === 'puertaId')) {
      db.execSync('ALTER TABLE offline_scans ADD COLUMN puertaId INTEGER;');
    }
    if (!offlineScanColumns.some((column) => column.name === 'deviceId')) {
      db.execSync('ALTER TABLE offline_scans ADD COLUMN deviceId INTEGER;');
    }

    const cachedKey = db.getFirstSync<{ value: string }>(
      'SELECT value FROM scanner_config WHERE key = ?;',
      ['ed25519.publicKey'],
    )?.value;
    const initialKey = PUBLIC_KEY_OVERRIDE || cachedKey || '';
    if (initialKey) {
      setPublicKey(initialKey);
      setKeyMessage(PUBLIC_KEY_OVERRIDE ? 'Clave pública fijada en la app.' : 'Clave pública guardada para uso offline.');
    }
    updatePendingCount();

    let cancelled = false;
    void SecureStore.getItemAsync('ticketing.staffGate').then((serializedShift) => {
      if (!serializedShift) {
        router.replace('/(staff)');
        return;
      }
      try {
        const parsed: unknown = JSON.parse(serializedShift);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'eventId' in parsed &&
          typeof parsed.eventId === 'number' &&
          'eventName' in parsed &&
          typeof parsed.eventName === 'string' &&
          'doorId' in parsed &&
          typeof parsed.doorId === 'number' &&
          'doorName' in parsed &&
          typeof parsed.doorName === 'string' &&
          'deviceId' in parsed &&
          typeof parsed.deviceId === 'number'
        ) {
          setShift(parsed as StaffShift);
        } else {
          router.replace('/(staff)');
        }
      } catch {
        router.replace('/(staff)');
      }
    });

    const refreshPublicKey = async () => {
      if (PUBLIC_KEY_OVERRIDE) return;
      try {
        const response = await fetch(`${API_URL}/scanner/public-key`);
        if (!response.ok) {
          throw new Error(`El backend respondió HTTP ${response.status}.`);
        }
        const result: { algorithm?: string; publicKeyBase64?: string } =
          await response.json();
        const decodedKey = Buffer.from(result.publicKeyBase64 ?? '', 'base64');
        if (
          result.algorithm !== 'Ed25519' ||
          decodedKey.length !== 32 ||
          !result.publicKeyBase64
        ) {
          throw new Error('El backend no devolvió una clave Ed25519 válida.');
        }
        if (!cancelled) {
          db.runSync(
            `INSERT INTO scanner_config (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
            ['ed25519.publicKey', result.publicKeyBase64],
          );
          setPublicKey(result.publicKeyBase64);
          setKeyMessage('Clave pública del backend guardada para uso offline.');
        }
      } catch (error) {
        if (!cancelled && !initialKey) {
          setKeyMessage(
            error instanceof Error
              ? `Sin clave verificada: ${error.message}`
              : 'Sin conexión y no hay una clave pública guardada.',
          );
        }
      }
    };

    void refreshPublicKey();
    return () => {
      cancelled = true;
    };
  }, [updatePendingCount]);

  const syncPendingScans = useCallback(async () => {
    if (!shift || syncing.current) return;
    syncing.current = true;
    setSyncMessage('Actualizando revocaciones y escaneos…');

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        router.replace('/(auth)/login');
        return;
      }
      const headers = { Authorization: `Bearer ${accessToken}` };
      const pendingScans = db.getAllSync<PendingScan>(
        `SELECT clientScanId, entradaId, eventoId, puertaId, escaneadoEn, deviceId
         FROM offline_scans
         WHERE eventoId IS NOT NULL AND puertaId IS NOT NULL AND deviceId IS NOT NULL
         ORDER BY id
         LIMIT 300;`,
      );
      const eventIds = [...new Set([
        shift.eventId,
        ...pendingScans.map((scan) => scan.eventoId),
      ])];
      const blockedEventIds = new Set<number>();

      for (const eventId of eventIds) {
        const cursorKey = `scanner.revocations.${eventId}`;
        const cursor = db.getFirstSync<{ value: string }>(
          'SELECT value FROM scanner_config WHERE key = ?;',
          [cursorKey],
        )?.value ?? new Date(0).toISOString();
        const revocationsResponse = await fetch(
          `${API_URL}/scanner/revocations?eventId=${eventId}&since=${encodeURIComponent(cursor)}`,
          { headers },
        );
        if (!revocationsResponse.ok) {
          const message = await responseError(revocationsResponse);
          if (
            eventId !== shift.eventId &&
            (message.includes('HTTP 403') ||
              message.includes('HTTP 404') ||
              message.includes('HTTP 409'))
          ) {
            blockedEventIds.add(eventId);
            continue;
          }
          throw new Error(message);
        }

        const revocationPayload: unknown = await revocationsResponse.json();
        if (
          typeof revocationPayload !== 'object' ||
          revocationPayload === null ||
          !('syncedAt' in revocationPayload) ||
          !('revocations' in revocationPayload) ||
          !Array.isArray(revocationPayload.revocations)
        ) {
          throw new Error('El backend devolvió una lista de revocaciones inválida.');
        }
        const syncedAt = revocationPayload.syncedAt;
        const revocations = revocationPayload.revocations;
        if (typeof syncedAt !== 'string') {
          throw new Error('El backend devolvió un cursor de revocaciones inválido.');
        }
        db.withTransactionSync(() => {
          for (const revocation of revocations) {
            if (
              typeof revocation !== 'object' ||
              revocation === null ||
              !('entradaId' in revocation) ||
              typeof revocation.entradaId !== 'number' ||
              !('revocadaEn' in revocation) ||
              typeof revocation.revocadaEn !== 'string' ||
              !('motivo' in revocation) ||
              typeof revocation.motivo !== 'string'
            ) {
              throw new Error('El backend devolvió un elemento de revocación inválido.');
            }
            db.runSync(
              `INSERT INTO revoked_entries (eventId, entradaId, revokedAt, reason)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(eventId, entradaId)
               DO UPDATE SET revokedAt = excluded.revokedAt, reason = excluded.reason;`,
              [eventId, revocation.entradaId, revocation.revocadaEn, revocation.motivo],
            );
          }
          db.runSync(
            `INSERT INTO scanner_config (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
            [cursorKey, new Date(Date.parse(syncedAt) - 60_000).toISOString()],
          );
        });
        if (eventId === shift.eventId) setRevocationsReady(true);
      }

      let syncedCount = 0;
      let rejectedCount = 0;
      let inaccessibleCount = 0;
      const batchesByDevice = new Map<number, PendingScan[]>();
      for (const scan of pendingScans) {
        if (blockedEventIds.has(scan.eventoId)) {
          inaccessibleCount++;
          continue;
        }
        const batch = batchesByDevice.get(scan.deviceId) ?? [];
        batch.push(scan);
        batchesByDevice.set(scan.deviceId, batch);
      }

      for (const [deviceId, scans] of batchesByDevice) {
        const batchResponse = await fetch(`${API_URL}/scanner/batches`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, scans }),
        });
        if (!batchResponse.ok) {
          const message = await responseError(batchResponse);
          if (
            scans.some((scan) => scan.eventoId !== shift.eventId) &&
            (message.includes('HTTP 403') ||
              message.includes('HTTP 404') ||
              message.includes('HTTP 409'))
          ) {
            inaccessibleCount += scans.length;
            continue;
          }
          throw new Error(message);
        }

        const batchPayload: unknown = await batchResponse.json();
        if (
          typeof batchPayload !== 'object' ||
          batchPayload === null ||
          !('results' in batchPayload) ||
          !Array.isArray(batchPayload.results)
        ) {
          throw new Error('El backend devolvió una respuesta de sincronización inválida.');
        }

        const resultById = new Map<string, string>();
        for (const result of batchPayload.results as ServerScanResult[]) {
          if (
            typeof result.clientScanId !== 'string' ||
            typeof result.resultado !== 'string'
          ) {
            throw new Error('El backend devolvió un resultado de escaneo inválido.');
          }
          resultById.set(result.clientScanId, result.resultado);
        }
        if (scans.some((scan) => !resultById.has(scan.clientScanId))) {
          throw new Error('El backend no confirmó todos los escaneos enviados.');
        }

        db.withTransactionSync(() => {
          for (const scan of scans) {
            const result = resultById.get(scan.clientScanId);
            if (result !== 'ok' && result !== 'duplicate') rejectedCount++;
            db.runSync('DELETE FROM offline_scans WHERE clientScanId = ?;', [scan.clientScanId]);
            syncedCount++;
          }
        });
      }

      updatePendingCount();
      const legacyCount = db.getFirstSync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM offline_scans
         WHERE eventoId IS NULL OR puertaId IS NULL OR deviceId IS NULL;`,
      )?.count ?? 0;
      const warnings = [];
      if (inaccessibleCount > 0) warnings.push(`${inaccessibleCount} de otro turno sin autorización vigente`);
      if (legacyCount > 0) warnings.push(`${legacyCount} escaneos antiguos requieren revisión manual`);
      if (rejectedCount > 0) warnings.push(`${rejectedCount} escaneos rechazados por el servidor`);
      setSyncMessage(
        warnings.length > 0
          ? `Sincronizados ${syncedCount}. Avisos: ${warnings.join('; ')}.`
          : syncedCount > 0
            ? `Sincronizados ${syncedCount} escaneos.`
            : 'Sincronizado. No hay escaneos pendientes.',
      );
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : 'Error desconocido.';
      console.warn('Scanner synchronization failed:', syncError);
      const isNetworkError =
        syncError instanceof TypeError ||
        /fetch failed|network request failed|internet connection appears to be offline|network error/i.test(message);
      setSyncMessage(
        isNetworkError
          ? 'Sin conexión. Tus escaneos permanecen guardados y se sincronizarán cuando vuelva internet.'
          : 'No pudimos sincronizar en este momento. Tus escaneos siguen guardados; inténtalo de nuevo.',
      );
      if (message.includes('HTTP 401')) {
        router.replace('/(auth)/login');
        return;
      }
      if (message.includes('HTTP 403') || message.includes('HTTP 404') || message.includes('HTTP 409')) {
        await SecureStore.deleteItemAsync('ticketing.staffGate');
        setShift(null);
        router.replace('/(staff)');
      }
      setRevocationsReady(true);
    } finally {
      syncing.current = false;
      updatePendingCount();
    }
  }, [shift, updatePendingCount]);

  useEffect(() => {
    if (!shift) return;
    setRevocationsReady(false);
    void syncPendingScans();
    const interval = setInterval(() => void syncPendingScans(), 20_000);
    return () => clearInterval(interval);
  }, [shift, syncPendingScans]);

  const handleBarcodeScanned = useCallback(({ data }: { data: string }) => {
    if (scanned) return;
    if (!shift || !revocationsReady) return;
    setScanned(true);

    if (!publicKey) {
      setScanStatus('invalid');
      setResultMessage('No hay clave pública confiable. Sincroniza la clave antes de escanear offline.');
      return;
    }

    const token = decodeRotatingToken(data);
    const entryId = token
      ? verifyRotatingToken(token, publicKey, shift.eventId)
        ? token.ticketId
        : null
      : verifyBase64Token(data, publicKey, shift.eventId);
    if (entryId === null) {
      setScanStatus('invalid');
      setResultMessage('Firma inválida o código fuera de su ventana de tiempo.');
      return;
    }

    const revoked = db.getFirstSync<{ reason: string }>(
      'SELECT reason FROM revoked_entries WHERE eventId = ? AND entradaId = ?;',
      [shift.eventId, entryId],
    );
    if (revoked) {
      setScanStatus('invalid');
      setResultMessage(`ENTRADA REVOCADA\n${revoked.reason}`);
      return;
    }

    const scannedAt = new Date().toISOString();
    const existing = db.getFirstSync<{ entradaId: number }>(
      'SELECT entradaId FROM local_entries WHERE entradaId = ?;',
      [entryId],
    );

    if (existing) {
      db.runSync(
        'INSERT INTO offline_scans (clientScanId, entradaId, escaneadoEn, resultado, eventoId, puertaId, deviceId) VALUES (?, ?, ?, ?, ?, ?, ?);',
        [Crypto.randomUUID(), entryId, scannedAt, 'duplicate', shift.eventId, shift.doorId, shift.deviceId],
      );
      setScanStatus('duplicate');
      setResultMessage(`DUPLICADO / ACCESO DENEGADO\nEntrada #${entryId} ya registrada en esta puerta.`);
    } else {
      db.withTransactionSync(() => {
        db.runSync(
          'INSERT INTO local_entries (entradaId, firstScannedAt) VALUES (?, ?);',
          [entryId, scannedAt],
        );
        db.runSync(
          'INSERT INTO offline_scans (clientScanId, entradaId, escaneadoEn, resultado, eventoId, puertaId, deviceId) VALUES (?, ?, ?, ?, ?, ?, ?);',
          [Crypto.randomUUID(), entryId, scannedAt, 'ok', shift.eventId, shift.doorId, shift.deviceId],
        );
      });
      setScanStatus('granted');
      setResultMessage(`ACCESO CONCEDIDO\nEntrada #${entryId}`);
    }
    updatePendingCount();
    void syncPendingScans();
  }, [publicKey, revocationsReady, scanned, shift, syncPendingScans, updatePendingCount]);

  if (!permission) {
    return (
      <View style={styles.permissionContainer}>
        <ActivityIndicator color="#12c4b2" />
        <Text style={styles.bodyText}>Consultando permisos de cámara…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.bodyText}>Se necesita acceso a la cámara para escanear entradas.</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Permitir cámara</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={
          scanned || !shift || !publicKey || !revocationsReady
            ? undefined
            : handleBarcodeScanned
        }
      />
      <SafeAreaView style={styles.overlay}>
        <View style={styles.headerRow}>
          <View style={styles.syncBadge}>
            <Text style={styles.syncText}>Pendientes: {pendingCount}</Text>
          </View>
          <TouchableOpacity onPress={() => router.replace('/(auth)/login')}>
            <Text style={styles.logoutText}>Salir</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.shiftBadge}>
          <Text style={styles.shiftText}>
            {shift ? `${shift.eventName} · ${shift.doorName}` : 'Cargando turno autorizado…'}
          </Text>
        </View>

        <View style={styles.keyBadge}>
          <View style={[styles.keyDot, publicKey ? styles.keyReady : styles.keyMissing]} />
          <Text style={styles.keyText}>{keyMessage}</Text>
        </View>

        <TouchableOpacity
          accessibilityRole="button"
          style={styles.syncButton}
          disabled={!shift || syncing.current}
          onPress={() => void syncPendingScans()}>
          <Text style={styles.syncButtonText}>
            {syncing.current ? 'Sincronizando…' : 'Sincronizar ahora'}
          </Text>
        </TouchableOpacity>
        <Text accessibilityLiveRegion="polite" style={styles.syncMessage}>
          {syncMessage}
        </Text>

        <View
          accessibilityLiveRegion="assertive"
          style={[
            styles.result,
            scanStatus === 'granted' && styles.resultGranted,
            scanStatus === 'duplicate' && styles.resultDuplicate,
            scanStatus === 'invalid' && styles.resultInvalid,
          ]}>
          <Text style={styles.resultText}>{resultMessage}</Text>
        </View>

        {scanned ? (
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.button}
            onPress={() => {
              setScanStatus('ready');
              setResultMessage('Apunta la cámara a un QR rotativo.');
              setScanned(false);
            }}>
            <Text style={styles.buttonText}>Escanear siguiente</Text>
          </TouchableOpacity>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#000', flex: 1 },
  permissionContainer: {
    alignItems: 'center',
    backgroundColor: '#092333',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  bodyText: { color: '#fff', fontSize: 16, marginVertical: 20, textAlign: 'center' },
  overlay: { flex: 1, justifyContent: 'space-between', padding: 20 },
  headerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  syncBadge: { backgroundColor: 'rgba(9,35,51,0.92)', borderRadius: 9, padding: 10 },
  syncText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  shiftBadge: { alignSelf: 'center', backgroundColor: 'rgba(9,35,51,0.92)', borderRadius: 9, marginTop: 12, padding: 10 },
  shiftText: { color: '#fff', fontSize: 13, fontWeight: '700', textAlign: 'center' },
  syncButton: { alignSelf: 'center', backgroundColor: '#12c4b2', borderRadius: 9, marginTop: 10, paddingHorizontal: 16, paddingVertical: 10 },
  syncButtonText: { color: '#092333', fontSize: 13, fontWeight: '800' },
  syncMessage: { alignSelf: 'center', backgroundColor: 'rgba(9,35,51,0.82)', borderRadius: 8, color: '#fff', fontSize: 11, marginTop: 6, padding: 8, textAlign: 'center' },
  logoutText: {
    backgroundColor: 'rgba(9,35,51,0.92)',
    borderRadius: 9,
    color: '#fff',
    overflow: 'hidden',
    padding: 10,
  },
  keyBadge: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(9,35,51,0.92)',
    borderRadius: 12,
    flexDirection: 'row',
    maxWidth: '100%',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  keyDot: { borderRadius: 5, height: 9, marginRight: 8, width: 9 },
  keyReady: { backgroundColor: '#12c4b2' },
  keyMissing: { backgroundColor: '#f59e0b' },
  keyText: { color: '#fff', flexShrink: 1, fontSize: 12 },
  result: {
    alignItems: 'center',
    backgroundColor: 'rgba(9,35,51,0.92)',
    borderRadius: 16,
    justifyContent: 'center',
    minHeight: 130,
    padding: 20,
  },
  resultGranted: { backgroundColor: 'rgba(4,120,87,0.96)' },
  resultDuplicate: { backgroundColor: 'rgba(185,28,28,0.97)' },
  resultInvalid: { backgroundColor: 'rgba(146,64,14,0.96)' },
  resultText: { color: '#fff', fontSize: 24, fontWeight: '900', textAlign: 'center' },
  button: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#12c4b2',
    borderRadius: 11,
    marginBottom: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  buttonText: { color: '#092333', fontSize: 15, fontWeight: '800' },
});
