import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useAudioRecorder, AudioModule, RecordingPresets } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { MaterialCommunityIcons } from '@expo/vector-icons';

// Verify your laptop's current Wi-Fi/Hotspot IP
const BACKEND_URL = 'http://10.200.140.82:8000';

interface ExerciseSet {
  set_number: number;
  reps: number;
  weight_kg: number;
  rpe?: number;
}

interface Exercise {
  name: string;
  sets: ExerciseSet[];
}

interface ParsedWorkoutResponse {
  status: string;
  workout_id: string;
  transcript: string;
  logged_at?: string;
  parsed: {
    exercises: Exercise[];
  };
}

function formatDateHeading(dateString?: string): string {
  if (!dateString) return 'Today';
  const date = new Date(dateString);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function groupWorkoutsByDate(workouts: ParsedWorkoutResponse[]) {
  const groups: { [key: string]: ParsedWorkoutResponse[] } = {};

  workouts.forEach((item) => {
    const key = formatDateHeading(item.logged_at);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
  });

  return groups;
}

export default function App() {
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ParsedWorkoutResponse[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const status = await AudioModule.requestRecordingPermissionsAsync();
        if (!status.granted) {
          Alert.alert('Permission Denied', 'Microphone access is required.');
          return;
        }

        await AudioModule.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
      } catch (err) {
        console.warn('Audio config error:', err);
      }
    })();

    fetchHistory();
  }, []);

  async function fetchHistory() {
    try {
      const res = await fetch(`${BACKEND_URL}/workouts`);
      if (res.ok) {
        const data: ParsedWorkoutResponse[] = await res.json();
        setHistory(data);
      } else {
        console.warn('GET /workouts failed with status:', res.status);
      }
    } catch (err) {
      console.warn('Could not fetch workouts:', err);
    }
  }

  async function startRecording() {
    try {
      await AudioModule.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await audioRecorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
      audioRecorder.record();
      setIsRecording(true);
    } catch (err: any) {
      Alert.alert('Recording Error', err?.message || 'Could not start recording.');
    }
  }

  async function stopRecording() {
    setIsRecording(false);
    setLoading(true);

    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) throw new Error('Recording URI is empty');

      await uploadAudio(uri);
    } catch (err: any) {
      Alert.alert('Upload Error', err?.message || 'Failed to upload audio.');
    } finally {
      setLoading(false);
    }
  }

  async function uploadAudio(audioUri: string) {
    const uploadResult = await FileSystem.uploadAsync(
      `${BACKEND_URL}/workouts/voice-entry`,
      audioUri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        mimeType: 'audio/m4a',
        headers: { Accept: 'application/json' },
      }
    );

    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      throw new Error(`Server returned ${uploadResult.status}: ${uploadResult.body}`);
    }

    const data: ParsedWorkoutResponse = JSON.parse(uploadResult.body);
    if (!data.logged_at) data.logged_at = new Date().toISOString();

    setHistory((prev) => [data, ...prev]);
  }

  const grouped = groupWorkoutsByDate(history);
  const dateKeys = Object.keys(grouped);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>Voice Habit Tracker</Text>
      <Text style={styles.subtitle}>Hold or tap to log your gym sets</Text>

      {/* Record Button */}
      <View style={styles.recordSection}>
        <TouchableOpacity
          style={[styles.recordButton, isRecording && styles.recordingActive]}
          onPress={isRecording ? stopRecording : startRecording}
          disabled={loading}
        >
          <MaterialCommunityIcons
            name={isRecording ? 'stop' : 'microphone'}
            size={42}
            color="#FFFFFF"
          />
        </TouchableOpacity>
        <Text style={styles.statusText}>
          {isRecording ? 'Listening... Tap to stop' : 'Tap to start recording'}
        </Text>
      </View>

      {loading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#38BDF8" />
          <Text style={styles.loadingText}>Transcribing & Parsing Workout...</Text>
        </View>
      )}

      {/* Workout History Grouped by Date */}
      <ScrollView style={styles.resultsContainer} showsVerticalScrollIndicator={false}>
        {dateKeys.length === 0 && !loading && (
          <Text style={styles.emptyText}>No workouts logged yet. Speak to add your first set!</Text>
        )}

        {dateKeys.map((dateKey) => (
          <View key={dateKey} style={styles.dateGroup}>
            <View style={styles.dateBadgeContainer}>
              <Text style={styles.dateBadgeText}>{dateKey}</Text>
            </View>

            {grouped[dateKey].map((item, idx) => (
              <View key={item.workout_id || idx} style={styles.workoutCard}>
                <Text style={styles.transcriptText}>"{item.transcript}"</Text>

                {item.parsed.exercises.map((exercise, eIdx) => (
                  <View key={eIdx} style={styles.exerciseBlock}>
                    <Text style={styles.exerciseName}>{exercise.name}</Text>
                    <View style={styles.setsList}>
                      {exercise.sets.map((set, sIdx) => (
                        <Text key={sIdx} style={styles.setText}>
                          • Set {set.set_number}: {set.reps} reps @ {set.weight_kg} kg
                          {set.rpe ? ` (RPE ${set.rpe})` : ''}
                        </Text>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#F8FAFC',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  recordSection: {
    alignItems: 'center',
    marginBottom: 16,
  },
  recordButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#2563EB',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
  },
  recordingActive: {
    backgroundColor: '#DC2626',
  },
  statusText: {
    marginTop: 8,
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '500',
  },
  loadingContainer: {
    alignItems: 'center',
    marginVertical: 12,
  },
  loadingText: {
    marginTop: 6,
    color: '#94A3B8',
    fontSize: 13,
  },
  resultsContainer: {
    flex: 1,
  },
  emptyText: {
    color: '#64748B',
    textAlign: 'center',
    marginTop: 40,
    fontSize: 14,
  },
  dateGroup: {
    marginBottom: 18,
  },
  dateBadgeContainer: {
    alignSelf: 'flex-start',
    backgroundColor: '#1E293B',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  dateBadgeText: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  workoutCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#38BDF8',
  },
  transcriptText: {
    color: '#94A3B8',
    fontStyle: 'italic',
    fontSize: 13,
    marginBottom: 8,
  },
  exerciseBlock: {
    marginTop: 4,
  },
  exerciseName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 4,
  },
  setsList: {
    paddingLeft: 4,
  },
  setText: {
    fontSize: 13,
    color: '#CBD5E1',
    marginVertical: 1,
  },
});