from datetime import datetime, timedelta, timezone
from typing import List, Optional, cast
from sqlalchemy.orm import Session
from sqlalchemy import func, desc, case
from app.models import Workout, Exercise, ExerciseSet
from app.schemas import WorkoutSummary, ExerciseStats, WeeklyVolumeComparison


def calculate_e1rm(weight: float, reps: int) -> float:
    """Calculate estimated 1RM using the Epley formula."""
    if reps<=0 or weight<=0:
        return 0.0
    if reps == 1:
        return round(weight,2)
    return round(weight * (1 + reps / 30), 2)  

def get_workout_summary(workout_id: str, db: Session) -> Optional[WorkoutSummary]:
    workout = db.query(Workout).filter(Workout.id == workout_id).first()
    if not workout:
        return None

    exercise_summaries: List[ExerciseStats]=[]
    total_workout_volume = 0.0

    for ex in workout.exercises:
        ex_vol=0.0
        ex_reps=0
        best_1rm=0.0

        for s in ex.sets:
            weight = float(s.weight_kg)
            reps=s.reps
            set_vol=weight*reps
            ex_vol+=set_vol
            ex_reps+=reps
            est_1rm=calculate_e1rm(weight, reps)

            if est_1rm>best_1rm:
                best_1rm=est_1rm

        total_workout_volume+=ex_vol
        exercise_summaries.append(ExerciseStats(
            exercise_name=ex.name,
            total_volume_kg=round(ex_vol,2),
            total_reps=ex_reps,
            best_estimated_1rm=round(best_1rm,2)
        ))

    logged_at_value = cast(datetime, workout.logged_at or datetime.now(timezone.utc))

    return WorkoutSummary(
        workout_id=str(workout.id),
        logged_at=logged_at_value,
        total_workout_volume=round(total_workout_volume,2),
        exercises=exercise_summaries,
    )



def get_weekly_volume_comparison(exercise_name: str, db: Session) ->WeeklyVolumeComparison:

    now=datetime.now(timezone.utc)
    current_week_start=now - timedelta(days=7)
    previous_week_start=now -timedelta(days=14)

    def get_stats_for_window(start_dt: datetime, end_dt: datetime):
        records=(
            db.query(ExerciseSet.weight_kg, ExerciseSet.reps)
            .join(Exercise, ExerciseSet.exercise_id==Exercise.id)
            .join(Workout, Exercise.workout_id==Workout.id)
            .filter(
                Exercise.name.ilike(f"%{exercise_name}%"),
                Workout.logged_at>=start_dt,
                Workout.logged_at<end_dt,
            ).all()
        )


        total_vol=0.0
        best_1rm=0.0

        for weight_kg, reps in records:
            w=float(weight_kg)
            total_vol+=w*reps
            e1rm=calculate_e1rm(w, reps)
            if e1rm>best_1rm:
                best_1rm=e1rm

        return total_vol, best_1rm

    curr_vol, curr_e1rm=get_stats_for_window(current_week_start, now)
    prev_vol, prev_e1rm=get_stats_for_window(previous_week_start, current_week_start)


    vol_change=None
    if prev_vol>0:
        vol_change=round(((curr_vol-prev_vol)/prev_vol)*100,2)

    e1rm_change=None

    if prev_e1rm>0:
        e1rm_change=round(((curr_e1rm-prev_e1rm)/prev_e1rm)*100,2)

    return WeeklyVolumeComparison(
        exercise_name=exercise_name,
        current_week_volume=round(curr_vol,2),
        previous_week_volume=round(prev_vol,2),
        volume_change_percentage=vol_change,
        current_week_best_1rm=round(curr_e1rm,2),
        previous_week_best_1rm=round(prev_e1rm,2),
        e1rm_change_percentage=e1rm_change
    )