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
import { API_URL } from '@/config/api';
import {
  decodeRotatingToken,
  TOKEN_WINDOW_SECONDS,
  verifyRotatingToken,
} from '@/lib/rotating-token';

const db = SQLite.openDatabaseSync('ticketing_offline.db');
const PUBLIC_KEY_OVERRIDE = process.env.EXPO_PUBLIC_ED25519_PUBLIC_KEY ?? '';

type ScanStatus = 'ready' | 'granted' | 'duplicate' | 'invalid';

function verifyBase64Token(data: string, publicKeyBase64: string): number | null {
  try {
    const decoded = Buffer.from(data, 'base64');
    if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) {
      return null;
    }

    const [entryIdText, timestampText, signatureBase64, ...extra] =
      decoded.toString('utf8').split(':');
    const entryId = Number(entryIdText);
    const timestamp = Number(timestampText);
    if (
      extra.length > 0 ||
      !Number.isSafeInteger(entryId) ||
      entryId <= 0 ||
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
    const payload = Buffer.from(`${entryId}:${timestamp}`, 'utf8');
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
  const [publicKey, setPublicKey] = useState('');
  const [keyMessage, setKeyMessage] = useState('Cargando clave pública…');
  const [scanStatus, setScanStatus] = useState<ScanStatus>('ready');
  const [resultMessage, setResultMessage] = useState('Apunta la cámara a un QR rotativo.');

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
        resultado TEXT NOT NULL
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

  const handleBarcodeScanned = useCallback(({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);

    if (!publicKey) {
      setScanStatus('invalid');
      setResultMessage('No hay clave pública confiable. Sincroniza la clave antes de escanear offline.');
      return;
    }

    const token = decodeRotatingToken(data);
    const entryId = token
      ? verifyRotatingToken(token, publicKey)
        ? token.ticketId
        : null
      : verifyBase64Token(data, publicKey);
    if (entryId === null) {
      setScanStatus('invalid');
      setResultMessage('Firma inválida o código fuera de su ventana de tiempo.');
      return;
    }

    const scannedAt = new Date().toISOString();
    const existing = db.getFirstSync<{ entradaId: number }>(
      'SELECT entradaId FROM local_entries WHERE entradaId = ?;',
      [entryId],
    );

    if (existing) {
      db.runSync(
        'INSERT INTO offline_scans (clientScanId, entradaId, escaneadoEn, resultado) VALUES (?, ?, ?, ?);',
        [Crypto.randomUUID(), entryId, scannedAt, 'duplicate'],
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
          'INSERT INTO offline_scans (clientScanId, entradaId, escaneadoEn, resultado) VALUES (?, ?, ?, ?);',
          [Crypto.randomUUID(), entryId, scannedAt, 'ok'],
        );
      });
      setScanStatus('granted');
      setResultMessage(`ACCESO CONCEDIDO\nEntrada #${entryId}`);
    }
    updatePendingCount();
  }, [publicKey, scanned, updatePendingCount]);

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
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
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

        <View style={styles.keyBadge}>
          <View style={[styles.keyDot, publicKey ? styles.keyReady : styles.keyMissing]} />
          <Text style={styles.keyText}>{keyMessage}</Text>
        </View>

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
