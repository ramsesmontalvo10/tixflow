import React, { useState } from 'react';
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

const STAFF_GATE_KEY = 'ticketing.staffGate';

const GATES = [
  { eventId: 6, eventName: 'Expo Tech Panama', gateId: 16, name: 'Puerta A · Acceso General' },
  { eventId: 6, eventName: 'Expo Tech Panama', gateId: 17, name: 'Puerta B · Acceso General' },
  { eventId: 6, eventName: 'Expo Tech Panama', gateId: 18, name: 'Puerta C · Acceso General' },
] as const;

type StaffGate = (typeof GATES)[number];

export default function StaffShiftScreen() {
  const [selectedGate, setSelectedGate] = useState<StaffGate | null>(null);
  const [isStartingShift, setIsStartingShift] = useState(false);
  const [error, setError] = useState('');

  const startScanning = async () => {
    if (!selectedGate || isStartingShift) return;

    setIsStartingShift(true);
    setError('');
    try {
      await SecureStore.setItemAsync(STAFF_GATE_KEY, JSON.stringify(selectedGate));
      router.push('/(staff)/scanner');
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? `No se pudo guardar la puerta seleccionada: ${saveError.message}`
          : 'No se pudo guardar la puerta seleccionada.',
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
          Selecciona la puerta donde trabajarás. La selección se guardará en este dispositivo antes de activar la cámara.
        </Text>

        <Text style={styles.sectionTitle}>Evento</Text>
        <View style={styles.eventCard}>
          <Text style={styles.eventName}>Expo Tech Panama</Text>
          <Text style={styles.eventDate}>07 de noviembre de 2026</Text>
        </View>

        <Text style={styles.sectionTitle}>Selecciona una puerta</Text>
        {GATES.map((gate) => {
          const isSelected = selectedGate?.gateId === gate.gateId;
          return (
            <TouchableOpacity
              key={gate.gateId}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              style={[styles.gateOption, isSelected && styles.gateOptionSelected]}
              onPress={() => {
                setSelectedGate(gate);
                setError('');
              }}>
              <View style={[styles.radio, isSelected && styles.radioSelected]}>
                {isSelected ? <View style={styles.radioDot} /> : null}
              </View>
              <View style={styles.gateDetails}>
                <Text style={styles.gateName}>{gate.name}</Text>
                <Text style={styles.gateMetadata}>
                  {gate.eventName} · Puerta #{gate.gateId}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}

        {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          accessibilityRole="button"
          style={[styles.startButton, (!selectedGate || isStartingShift) && styles.startButtonDisabled]}
          disabled={!selectedGate || isStartingShift}
          onPress={() => void startScanning()}>
          {isStartingShift ? (
            <ActivityIndicator color="#092333" />
          ) : (
            <Text style={styles.startButtonText}>Iniciar Escaneo</Text>
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
  eventCard: { backgroundColor: '#e5f8f5', borderRadius: 13, padding: 16 },
  eventName: { color: '#092333', fontSize: 16, fontWeight: '800' },
  eventDate: { color: '#49716f', fontSize: 13, marginTop: 5 },
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
  radio: {
    alignItems: 'center',
    borderColor: '#98aab3',
    borderRadius: 10,
    borderWidth: 2,
    height: 20,
    justifyContent: 'center',
    marginRight: 13,
    width: 20,
  },
  radioSelected: { borderColor: '#0b8f87' },
  radioDot: { backgroundColor: '#0b8f87', borderRadius: 5, height: 10, width: 10 },
  gateDetails: { flex: 1 },
  gateName: { color: '#092333', fontSize: 15, fontWeight: '700' },
  gateMetadata: { color: '#687b89', fontSize: 12, marginTop: 4 },
  error: { backgroundColor: '#fff3e8', borderRadius: 10, color: '#9a4b00', marginTop: 12, padding: 12 },
  startButton: {
    alignItems: 'center',
    backgroundColor: '#12c4b2',
    borderRadius: 12,
    marginTop: 22,
    padding: 16,
  },
  startButtonDisabled: { opacity: 0.5 },
  startButtonText: { color: '#092333', fontSize: 16, fontWeight: '800' },
});
