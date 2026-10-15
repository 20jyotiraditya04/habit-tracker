
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { MaterialCommunityIcons } from '@expo/vector-icons';

// Change this if your laptop's local IP changes.
const BACKEND_URL = 'http://10.200.140.82:8000';

interface ExerciseSet {
  id: string;
  set_number: number;
  reps: number;
  weight_kg: number;
  rpe: number | null;
}

interface Exercise {
  name: string;
  sets: ExerciseSet[];
}

interface Workout {
  status: string;
  workout_id: string;
  transcript: string;
  logged_at?: string;
  parsed: {
    exercises: Exercise[];
  };
}

interface EditValues {
  reps: string;
  weight_kg: string;
  rpe: string;
}

function formatDateHeading(dateString?: string): string {
  if (!dateString) return 'Unknown date';

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

function groupWorkoutsByDate(workouts: Workout[]) {
  const groups: Record<string, Workout[]> = {};

  workouts.forEach((workout) => {
    const key = formatDateHeading(workout.logged_at);
    if (!groups[key]) groups[key] = [];
    groups[key].push(workout);
  });

  return groups;
}

function getWorkoutVolume(workout: Workout): number {
  return workout.parsed.exercises.reduce(
    (exerciseTotal, exercise) =>
      exerciseTotal +
      exercise.sets.reduce(
        (setTotal, set) =>
          setTotal +
          (Number(set.weight_kg) || 0) * (Number(set.reps) || 0),
        0,
      ),
    0,
  );
}

export default function App() {
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const [isRecording, setIsRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<Workout[]>([]);

  const [editingSetId, setEditingSetId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<EditValues>({
    reps: '',
    weight_kg: '',
    rpe: '',
  });

  const [savingSet, setSavingSet] = useState(false);
  const [deletingSetId, setDeletingSetId] = useState<string | null>(null);
  const [deletingWorkoutId, setDeletingWorkoutId] = useState<string | null>(null);
  const [actionsWorkoutId, setActionsWorkoutId] = useState<string | null>(null);

  useEffect(() => {
    async function configureAudio() {
      try {
        const permission =
          await AudioModule.requestRecordingPermissionsAsync();

        if (!permission.granted) {
          Alert.alert(
            'Permission Denied',
            'Microphone access is required to record workouts.',
          );
          return;
        }

        await AudioModule.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
      } catch (error) {
        console.warn('Audio configuration error:', error);
      }
    }

    void configureAudio();
    void fetchHistory();
  }, []);

  async function fetchHistory(showError = false) {
    try {
      const response = await fetch(`${BACKEND_URL}/workouts?limit=500`);

      if (!response.ok) {
        throw new Error(`GET /workouts returned ${response.status}`);
      }

      const data: Workout[] = await response.json();
      setHistory(data);
    } catch (error) {
      console.warn('Could not fetch workouts:', error);

      if (showError) {
        Alert.alert(
          'Refresh Failed',
          'Could not refresh workout history. Check your connection and try again.',
        );
      }
    }
  }

  async function startRecording() {
    try {
      await AudioModule.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await audioRecorder.prepareToRecordAsync(
        RecordingPresets.HIGH_QUALITY,
      );

      audioRecorder.record();
      setIsRecording(true);
    } catch (error: any) {
      Alert.alert(
        'Recording Error',
        error?.message || 'Could not start recording.',
      );
    }
  }

  async function stopRecording() {
    setIsRecording(false);
    setLoading(true);

    try {
      await audioRecorder.stop();

      const uri = audioRecorder.uri;
      if (!uri) throw new Error('Recording URI is empty.');

      await uploadAudio(uri);
      await fetchHistory();

      Alert.alert('Success', 'Workout recorded successfully.');
    } catch (error: any) {
      Alert.alert(
        'Upload Error',
        error?.message || 'Failed to upload the recording.',
      );
    } finally {
      setLoading(false);
    }
  }

  async function uploadAudio(audioUri: string) {
    const result = await FileSystem.uploadAsync(
      `${BACKEND_URL}/workouts/voice-entry`,
      audioUri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        mimeType: 'audio/m4a',
        headers: { Accept: 'application/json' },
      },
    );

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Server returned ${result.status}: ${result.body}`);
    }
  }

  function beginEditing(set: ExerciseSet) {
    if (!set.id) {
      Alert.alert(
        'Set ID Missing',
        'Ensure GET /workouts returns an ID for every set.',
      );
      return;
    }

    setEditingSetId(set.id);
    setEditValues({
      reps: String(set.reps ?? 0),
      weight_kg: String(set.weight_kg ?? 0),
      rpe: set.rpe == null ? '' : String(set.rpe),
    });
  }

  async function saveSet(setId: string) {
    const reps = Number(editValues.reps);
    const weight = Number(editValues.weight_kg);
    const rpe =
      editValues.rpe.trim() === '' ? null : Number(editValues.rpe);

    if (
      editValues.reps.trim() === '' ||
      !Number.isInteger(reps) ||
      reps < 0
    ) {
      Alert.alert('Invalid Reps', 'Enter a whole number of reps (0 or more).');
      return;
    }

    if (
      editValues.weight_kg.trim() === '' ||
      !Number.isFinite(weight) ||
      weight < 0
    ) {
      Alert.alert('Invalid Weight', 'Enter a valid weight of 0 kg or more.');
      return;
    }

    if (
      rpe !== null &&
      (!Number.isInteger(rpe) || rpe < 1 || rpe > 10)
    ) {
      Alert.alert('Invalid RPE', 'RPE must be from 1 to 10, or left blank.');
      return;
    }

    setSavingSet(true);

    try {
      const response = await fetch(
        `${BACKEND_URL}/sets/${encodeURIComponent(setId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            reps,
            weight_kg: weight,
            rpe,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Update failed (${response.status}): ${await response.text()}`);
      }

      setEditingSetId(null);
      await fetchHistory();
      Alert.alert('Saved', 'Set updated successfully.');
    } catch (error: any) {
      Alert.alert(
        'Update Failed',
        error?.message || 'Could not update this set.',
      );
    } finally {
      setSavingSet(false);
    }
  }

  function confirmDeleteSet(set: ExerciseSet) {
    if (!set.id) {
      Alert.alert('Error', 'This set has no database ID.');
      return;
    }

    Alert.alert(
      'Delete Set',
      `Delete Set ${set.set_number}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void deleteSet(set.id),
        },
      ],
    );
  }

  async function deleteSet(setId: string) {
    setDeletingSetId(setId);

    try {
      const response = await fetch(
        `${BACKEND_URL}/sets/${encodeURIComponent(setId)}`,
        {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
        },
      );

      if (!response.ok) {
        throw new Error(`Delete failed (${response.status}): ${await response.text()}`);
      }

      if (editingSetId === setId) setEditingSetId(null);

      await fetchHistory();
      Alert.alert('Deleted', 'Set deleted successfully.');
    } catch (error: any) {
      Alert.alert(
        'Delete Failed',
        error?.message || 'Could not delete this set.',
      );
    } finally {
      setDeletingSetId(null);
    }
  }

  function confirmDeleteWorkout(workout: Workout) {
    Alert.alert(
      'Delete Entire Workout',
      'This permanently deletes the workout, transcript, exercises, and all sets.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Workout',
          style: 'destructive',
          onPress: () => void deleteWorkout(workout.workout_id),
        },
      ],
    );
  }

  async function deleteWorkout(workoutId: string) {
    setDeletingWorkoutId(workoutId);

    try {
      const response = await fetch(
        `${BACKEND_URL}/workouts/${encodeURIComponent(workoutId)}`,
        {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
        },
      );

      if (!response.ok) {
        throw new Error(`Delete failed (${response.status}): ${await response.text()}`);
      }

      setEditingSetId(null);
      setActionsWorkoutId(null);
      setHistory((current) =>
        current.filter((workout) => workout.workout_id !== workoutId),
      );

      Alert.alert('Deleted', 'Workout deleted successfully.');
    } catch (error: any) {
      Alert.alert(
        'Delete Failed',
        error?.message ||
          'Could not delete the workout. Check DELETE /workouts/{workout_id}.',
      );
    } finally {
      setDeletingWorkoutId(null);
    }
  }

  const grouped = groupWorkoutsByDate(history);
  const dateKeys = Object.keys(grouped);

  // Dashboard metrics calculated from workout history.
  const totalSets = history.reduce(
    (total, workout) =>
      total +
      workout.parsed.exercises.reduce(
        (exerciseTotal, exercise) => exerciseTotal + exercise.sets.length,
        0,
      ),
    0,
  );

  const totalVolume = history.reduce(
    (total, workout) => total + getWorkoutVolume(workout),
    0,
  );

  const lastSevenDays = Array.from({ length: 7 }, (_, index) => {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - (6 - index));

    const volume = history.reduce((total, workout) => {
      if (!workout.logged_at) return total;

      const workoutDate = new Date(workout.logged_at);
      if (workoutDate.toDateString() !== day.toDateString()) return total;

      return total + getWorkoutVolume(workout);
    }, 0);

    const workouts = history.filter(
      (workout) =>
        workout.logged_at &&
        new Date(workout.logged_at).toDateString() === day.toDateString(),
    ).length;

    return {
      label: day.toLocaleDateString(undefined, { weekday: 'short' }),
      volume,
      workouts,
    };
  });

  const maxDailyVolume = Math.max(
    ...lastSevenDays.map((day) => day.volume),
    1,
  );

  const workoutsThisWeek = lastSevenDays.reduce(
    (total, day) => total + day.workouts,
    0,
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      <Text style={styles.title}>Voice Habit Tracker</Text>
      <Text style={styles.subtitle}>Speak to log your gym sets</Text>

      <ScrollView
        style={styles.resultsContainer}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.recordSection}>
          <TouchableOpacity
            style={[
              styles.recordButton,
              isRecording && styles.recordingActive,
            ]}
            onPress={isRecording ? stopRecording : startRecording}
            disabled={loading}
            accessibilityLabel={
              isRecording ? 'Stop recording' : 'Start recording'
            }
          >
            <MaterialCommunityIcons
              name={isRecording ? 'stop' : 'microphone'}
              size={38}
              color="#FFFFFF"
            />
          </TouchableOpacity>

          <Text style={styles.statusText}>
            {isRecording
              ? 'Listening... Tap to stop'
              : 'Tap to start recording'}
          </Text>
        </View>

        {loading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#38BDF8" />
            <Text style={styles.loadingText}>
              Transcribing and parsing workout...
            </Text>
          </View>
        )}

        {/* Workout analytics dashboard */}
        <View style={styles.dashboardSection}>
          <View style={styles.dashboardHeadingRow}>
            <View>
              <Text style={styles.dashboardTitle}>Your Progress</Text>
              <Text style={styles.dashboardSubtitle}>
                Based on your recent workout history
              </Text>
            </View>

            <MaterialCommunityIcons
              name="chart-box-outline"
              size={26}
              color="#38BDF8"
            />
          </View>

          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <MaterialCommunityIcons
                name="dumbbell"
                size={21}
                color="#38BDF8"
              />
              <Text style={styles.statValue}>{history.length}</Text>
              <Text style={styles.statLabel}>Workouts logged</Text>
            </View>

            <View style={styles.statCard}>
              <MaterialCommunityIcons
                name="format-list-numbered"
                size={21}
                color="#A78BFA"
              />
              <Text style={styles.statValue}>{totalSets}</Text>
              <Text style={styles.statLabel}>Sets logged</Text>
            </View>

            <View style={styles.statCard}>
              <MaterialCommunityIcons
                name="weight-kilogram"
                size={21}
                color="#34D399"
              />
              <Text style={styles.statValue}>
                {Math.round(totalVolume).toLocaleString()}
              </Text>
              <Text style={styles.statLabel}>Total volume (kg × reps)</Text>
            </View>

            <View style={styles.statCard}>
              <MaterialCommunityIcons
                name="calendar-week"
                size={21}
                color="#FBBF24"
              />
              <Text style={styles.statValue}>{workoutsThisWeek}</Text>
              <Text style={styles.statLabel}>Workouts in 7 days</Text>
            </View>
          </View>

          <View style={styles.chartCard}>
            <View style={styles.chartHeadingRow}>
              <Text style={styles.chartTitle}>Training Volume</Text>
              <Text style={styles.chartSubtitle}>Last 7 days</Text>
            </View>

            <View style={styles.barChart}>
              {lastSevenDays.map((day, index) => (
                <View key={`${day.label}-${index}`} style={styles.barColumn}>
                  <Text style={styles.barValue}>
                    {day.volume > 0
                      ? day.volume >= 1000
                        ? `${(day.volume / 1000).toFixed(1)}k`
                        : Math.round(day.volume)
                      : '—'}
                  </Text>

                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        {
                          height:
                            day.volume > 0
                              ? `${Math.max(
                                  (day.volume / maxDailyVolume) * 100,
                                  5,
                                )}%`
                              : 0,
                        },
                      ]}
                    />
                  </View>

                  <Text style={styles.barLabel}>{day.label}</Text>
                </View>
              ))}
            </View>

            <Text style={styles.chartFootnote}>
              Volume = weight (kg) × reps. Sets logged at 0 kg do not
              contribute to weighted volume.
            </Text>
          </View>
        </View>

        {/* Workout history */}
        <View style={styles.historyHeader}>
          <Text style={styles.historyTitle}>Workout History</Text>

          <TouchableOpacity
            onPress={() => void fetchHistory(true)}
            style={styles.refreshButton}
          >
            <MaterialCommunityIcons
              name="refresh"
              size={18}
              color="#38BDF8"
            />
            <Text style={styles.refreshText}>Refresh</Text>
          </TouchableOpacity>
        </View>

        {dateKeys.length === 0 && !loading && (
          <Text style={styles.emptyText}>
            No workouts logged yet. Speak to add your first set!
          </Text>
        )}

        {dateKeys.map((dateKey) => (
          <View key={dateKey} style={styles.dateGroup}>
            <View style={styles.dateBadgeContainer}>
              <Text style={styles.dateBadgeText}>{dateKey}</Text>
            </View>

            {grouped[dateKey].map((workout, workoutIndex) => (
              <TouchableOpacity
                key={workout.workout_id || workoutIndex}
                style={styles.workoutCard}
                activeOpacity={1}
                delayLongPress={500}
                onLongPress={() =>
                  setActionsWorkoutId((current) =>
                    current === workout.workout_id
                      ? null
                      : workout.workout_id,
                  )
                }
                accessibilityHint="Press and hold to show edit and delete actions"
              >
                <View style={styles.workoutTopRow}>
                  <Text style={styles.transcriptText}>
                    "{workout.transcript}"
                  </Text>

                  {actionsWorkoutId === workout.workout_id && (
                    <TouchableOpacity
                      style={styles.deleteWorkoutButton}
                      onPress={() => confirmDeleteWorkout(workout)}
                      disabled={
                        deletingWorkoutId === workout.workout_id
                      }
                      accessibilityLabel="Delete entire workout"
                    >
                      {deletingWorkoutId === workout.workout_id ? (
                        <ActivityIndicator
                          size="small"
                          color="#F87171"
                        />
                      ) : (
                        <>
                          <MaterialCommunityIcons
                            name="delete-forever-outline"
                            size={18}
                            color="#F87171"
                          />
                          <Text style={styles.deleteWorkoutText}>
                            Delete workout
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                </View>

                {actionsWorkoutId !== workout.workout_id && (
                  <Text style={styles.holdHint}>
                    Hold workout to show edit/delete options
                  </Text>
                )}

                {workout.parsed.exercises.map(
                  (exercise, exerciseIndex) => (
                    <View
                      key={`${workout.workout_id}-${exerciseIndex}`}
                      style={styles.exerciseBlock}
                    >
                      <Text style={styles.exerciseName}>
                        {exercise.name}
                      </Text>

                      {exercise.sets.map((set, setIndex) => {
                        const isEditing = editingSetId === set.id;
                        const isDeleting = deletingSetId === set.id;

                        return (
                          <View
                            key={
                              set.id ||
                              `${exercise.name}-${setIndex}`
                            }
                            style={styles.setCard}
                          >
                            {isEditing ? (
                              <View style={styles.editForm}>
                                <Text style={styles.editLabel}>
                                  Set {set.set_number}
                                </Text>

                                <View style={styles.inputRow}>
                                  <View style={styles.inputGroup}>
                                    <Text style={styles.inputLabel}>
                                      Reps
                                    </Text>
                                    <TextInput
                                      value={editValues.reps}
                                      onChangeText={(value) =>
                                        setEditValues((prev) => ({
                                          ...prev,
                                          reps: value,
                                        }))
                                      }
                                      keyboardType="number-pad"
                                      style={styles.input}
                                      selectTextOnFocus
                                    />
                                  </View>

                                  <View style={styles.inputGroup}>
                                    <Text style={styles.inputLabel}>
                                      Weight (kg)
                                    </Text>
                                    <TextInput
                                      value={editValues.weight_kg}
                                      onChangeText={(value) =>
                                        setEditValues((prev) => ({
                                          ...prev,
                                          weight_kg: value,
                                        }))
                                      }
                                      keyboardType="decimal-pad"
                                      style={styles.input}
                                      selectTextOnFocus
                                    />
                                  </View>

                                  <View style={styles.inputGroup}>
                                    <Text style={styles.inputLabel}>
                                      RPE
                                    </Text>
                                    <TextInput
                                      value={editValues.rpe}
                                      onChangeText={(value) =>
                                        setEditValues((prev) => ({
                                          ...prev,
                                          rpe: value,
                                        }))
                                      }
                                      keyboardType="number-pad"
                                      placeholder="—"
                                      placeholderTextColor="#64748B"
                                      style={styles.input}
                                      selectTextOnFocus
                                    />
                                  </View>
                                </View>

                                <View style={styles.actionRow}>
                                  <TouchableOpacity
                                    style={[
                                      styles.actionButton,
                                      styles.saveButton,
                                    ]}
                                    onPress={() =>
                                      void saveSet(set.id)
                                    }
                                    disabled={savingSet}
                                  >
                                    {savingSet ? (
                                      <ActivityIndicator color="#FFFFFF" />
                                    ) : (
                                      <Text style={styles.actionButtonText}>
                                        Save
                                      </Text>
                                    )}
                                  </TouchableOpacity>

                                  <TouchableOpacity
                                    style={[
                                      styles.actionButton,
                                      styles.cancelButton,
                                    ]}
                                    onPress={() => setEditingSetId(null)}
                                    disabled={savingSet}
                                  >
                                    <Text style={styles.actionButtonText}>
                                      Cancel
                                    </Text>
                                  </TouchableOpacity>
                                </View>
                              </View>
                            ) : (
                              <View style={styles.setDisplayRow}>
                                <View style={styles.setInfo}>
                                  <Text style={styles.setText}>
                                    Set {set.set_number}: {set.reps} reps @{' '}
                                    {set.weight_kg} kg
                                    {set.rpe != null
                                      ? ` (RPE ${set.rpe})`
                                      : ''}
                                  </Text>
                                </View>

                                {actionsWorkoutId ===
                                  workout.workout_id && (
                                  <View style={styles.iconActions}>
                                    <TouchableOpacity
                                      style={styles.iconButton}
                                      onPress={() => beginEditing(set)}
                                      accessibilityLabel={`Edit set ${set.set_number}`}
                                    >
                                      <MaterialCommunityIcons
                                        name="pencil"
                                        size={18}
                                        color="#38BDF8"
                                      />
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                      style={styles.iconButton}
                                      onPress={() =>
                                        confirmDeleteSet(set)
                                      }
                                      disabled={isDeleting}
                                      accessibilityLabel={`Delete set ${set.set_number}`}
                                    >
                                      {isDeleting ? (
                                        <ActivityIndicator
                                          size="small"
                                          color="#F87171"
                                        />
                                      ) : (
                                        <MaterialCommunityIcons
                                          name="trash-can-outline"
                                          size={18}
                                          color="#F87171"
                                        />
                                      )}
                                    </TouchableOpacity>
                                  </View>
                                )}
                              </View>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  ),
                )}
              </TouchableOpacity>
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
    marginBottom: 18,
    marginTop: 8,
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
  dashboardSection: {
    marginBottom: 20,
  },
  dashboardHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  dashboardTitle: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '700',
  },
  dashboardSubtitle: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  statCard: {
    width: '48%',
    flexGrow: 1,
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 12,
    minHeight: 104,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statValue: {
    color: '#F8FAFC',
    fontSize: 22,
    fontWeight: '700',
    marginTop: 5,
  },
  statLabel: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  chartCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  chartHeadingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  chartTitle: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  chartSubtitle: {
    color: '#94A3B8',
    fontSize: 11,
  },
  barChart: {
    height: 130,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'stretch',
    gap: 6,
  },
  barColumn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  barValue: {
    color: '#CBD5E1',
    fontSize: 9,
    marginBottom: 4,
  },
  barTrack: {
    width: '70%',
    height: 88,
    justifyContent: 'flex-end',
    backgroundColor: '#0F172A',
    borderRadius: 5,
    overflow: 'hidden',
  },
  barFill: {
    width: '100%',
    backgroundColor: '#38BDF8',
    borderRadius: 5,
  },
  barLabel: {
    color: '#94A3B8',
    fontSize: 10,
    marginTop: 5,
  },
  chartFootnote: {
    color: '#64748B',
    fontSize: 10,
    marginTop: 10,
    lineHeight: 14,
  },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  historyTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '700',
  },
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  refreshText: {
    color: '#38BDF8',
    fontSize: 13,
    fontWeight: '600',
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
  workoutTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
  },
  transcriptText: {
    color: '#94A3B8',
    fontStyle: 'italic',
    fontSize: 13,
    flex: 1,
  },
  holdHint: {
    color: '#64748B',
    fontSize: 10,
    marginTop: 2,
    marginBottom: 5,
  },
  deleteWorkoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 6,
    backgroundColor: '#3F1D2A',
  },
  deleteWorkoutText: {
    color: '#F87171',
    fontSize: 11,
    fontWeight: '700',
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
  setCard: {
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    paddingVertical: 5,
  },
  setDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  setInfo: {
    flex: 1,
    paddingRight: 8,
  },
  setText: {
    fontSize: 13,
    color: '#CBD5E1',
    marginVertical: 1,
  },
  iconActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconButton: {
    padding: 7,
    marginLeft: 4,
  },
  editForm: {
    paddingVertical: 6,
  },
  editLabel: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  inputGroup: {
    flex: 1,
  },
  inputLabel: {
    color: '#94A3B8',
    fontSize: 11,
    marginBottom: 4,
  },
  input: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 7,
    color: '#F8FAFC',
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 14,
    minWidth: 0,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  actionButton: {
    borderRadius: 7,
    paddingVertical: 9,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 84,
  },
  saveButton: {
    backgroundColor: '#0284C7',
  },
  cancelButton: {
    backgroundColor: '#475569',
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
});
