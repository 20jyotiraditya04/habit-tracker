from decimal import Decimal
import os
import shutil
import tempfile
import json
from pathlib import Path
from typing import List, Optional, cast
import re
from uuid import UUID
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends
from pydantic import BaseModel, Field, field_validator
from openai import OpenAI
from faster_whisper import WhisperModel
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker, Session, joinedload
from app.analytics import get_workout_summary, get_weekly_volume_comparison
from app.schemas import WorkoutSummary, WeeklyVolumeComparison, SetUpdate
from app.models import Base, Workout, Exercise, ExerciseSet

# Locate .env at the root of habit-tracker
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://dev_user:dev_password@localhost:5432/habit_tracker")
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Voice Workout Tracker")

# 1. Initialize local faster-whisper model
whisper_model = WhisperModel("base", device="cpu", compute_type="int8")

# 2. Ollama client for structured parsing (localhost:11434 by default)
ollama_client = OpenAI(
    api_key="ollama",
    base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ExtractedSet(BaseModel):
    set_number: int
    reps: Optional[int] = Field(default=0, ge=0)
    weight_kg: Optional[float] = Field(default=0.0, ge=0)
    rpe: Optional[float] = Field(default=None, ge=1, le=10)

    @field_validator("weight_kg", mode="before")
    def default_null_weight(cls, v):
        return 0.0 if v is None else v

    @field_validator("reps", mode="before")
    def default_null_reps(cls, v):
        return 0 if v is None else v


class ExtractedExercise(BaseModel):
    name: str
    sets: List[ExtractedSet]


class ExtractedWorkout(BaseModel):
    exercises: List[ExtractedExercise]


@app.get("/")
def health_check():
    return {"status": "ok", "service": "Voice Workout Tracker"}


# -------------------------------------------------------------
# Workouts History Endpoint
# -------------------------------------------------------------
@app.get("/workouts")
def get_workouts(limit: int = 50, db: Session = Depends(get_db)):
    """Fetch past workouts sorted from newest to oldest by logged_at."""
    workouts = (
        db.query(Workout)
        .options(joinedload(Workout.exercises).joinedload(Exercise.sets))
        .order_by(Workout.logged_at.desc())
        .limit(limit)
        .all()
    )

    results = []
    for w in workouts:
        results.append({
            "status": "success",
            "workout_id": str(w.id),
            "transcript": w.raw_transcript,
            "logged_at": w.logged_at.isoformat() if getattr(w, "logged_at", None) else None,
            "parsed": {
                "exercises": [
                    {
                        "name": ex.name,
                        "sets": [
                            {
                                "id": str(s.id),
                                "set_number": s.set_number,
                                "reps": s.reps if s.reps is not None else 0,
                                "weight_kg": float(s.weight_kg or 0.0),
                                "rpe": s.rpe,
                            }
                            for s in ex.sets
                        ],
                    }
                    for ex in w.exercises
                ]
            },
        })
    return results


@app.patch("/sets/{set_id}")
def update_set(
    set_id:UUID,
    payload:SetUpdate,
    db: Session=Depends(get_db),
):
    """Update reps, weight, and/or RPE for a single exercise set."""
    exercise_set=(
        db.query(ExerciseSet)
        .filter(ExerciseSet.id==set_id)
        .first()
    )

    if exercise_set is None:
        raise HTTPException(status_code=404, detail="Set not found")

    updates=payload.model_dump(exclude_unset=True)

    if not updates:
        raise HTTPException(
            status_code=400,
            detail="Provide atleast one field to update",
        )


    for field in ("reps", "weight_kg"):
        if field in updates and updates[field] is None:
            raise HTTPException(
                status_code=400,
                detail=f"{field} cannot be null",
            )

    try:
        for field, value in updates.items():
            setattr(exercise_set, field, value)

        db.commit()
        db.refresh(exercise_set)
        weight =cast(Decimal|float| None, exercise_set.weight_kg)
        return {
            "status": "success",
            "message": "Set Updated Successfully",
            "set": {
                "id": str(exercise_set.id),
                "set_number": exercise_set.set_number,
                "reps": exercise_set.reps,
                "weight_kg": float(weight or 0.0),
                "rpe": exercise_set.rpe,
            }
        }
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="An error occurred while updating the set",
        )

@app.delete("/sets/{set_id}")

def delete_set(
    set_id:UUID,
    db: Session=Depends(get_db),
    ):
    """Delete a single exercise set and renumber the remaining sets."""

    exercise_set=(
        db.query(ExerciseSet)
        .filter(ExerciseSet.id==set_id)
        .first()
    )
    if exercise_set is None:
        raise HTTPException(status_code=404,
                            detail="Set not found")

    exercise_id=exercise_set.exercise_id


    try:
        db.delete(exercise_set)
        db.flush()

        remaining_sets=(
            db.query(ExerciseSet)
            .filter(ExerciseSet.exercise_id==exercise_id)
            .order_by(
                ExerciseSet.set_number,
                ExerciseSet.id,
            )
            .all()
        )
        for number, remaining_set in enumerate(
            remaining_sets, start=1
        ):
            remaining_set.set_number=number

        db.commit()
        return {
            "status": "success",
            "message":"set deleted successfully",
            "deleted_set_id": str(set_id),
            "remaining_sets":len(remaining_sets),
        }

    except SQLAlchemyError:
        db.rollback()
        return HTTPException(
            status_code=500,
            detail="Failed to delete set",
        )

@app.delete("/workouts/{workout_id}")
def delete_workout(
    workout_id:UUID,
    db: Session=Depends(get_db),
):
    """Delete a workout and all associated exercises and sets."""
    workout=(
        db.query(Workout)
        .filter(Workout.id==workout_id)
        .first()
    )
    if workout is None:
        raise HTTPException(status_code=404, detail="Workout not found")

    try:
        db.delete(workout)
        db.commit()
        return {
            "status": "success",
            "message": "Workout deleted successfully",
            "deleted_workout_id": str(workout_id),
        }
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="Failed to delete workout",
        )
    



@app.get("/analytics/workout-summary/{workout_id}", response_model=WorkoutSummary)
def read_workout_summary(workout_id: str, db: Session = Depends(get_db)):
    summary = get_workout_summary(workout_id, db)
    if not summary:
        raise HTTPException(status_code=404, detail="Workout not found")
    return summary


@app.get("/analytics/progression", response_model=WeeklyVolumeComparison)
def read_exercise_progression(exercise_name: str, db: Session = Depends(get_db)):
    return get_weekly_volume_comparison(exercise_name, db)


@app.post("/workouts/voice-entry", status_code=201)
async def log_workout_voice(
    file: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    filename = file.filename or "voice-recording.m4a"
    suffix = f".{filename.rsplit('.', 1)[-1]}" if "." in filename else ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        # Step A: Local transcription via faster-whisper
        segments, _ = whisper_model.transcribe(tmp_path, beam_size=5, language="en")
        raw_text = " ".join([segment.text for segment in segments]).strip()

        if not raw_text:
            raise HTTPException(status_code=422, detail="No speech detected in audio")

        # Step B: Structured parsing via Ollama
        ollama_model = os.getenv("OLLAMA_MODEL", "mistral")
        
        completion = ollama_client.chat.completions.create(
            model=ollama_model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a fitness assistant. Parse gym workout speech into structured exercise data. "
                        "Respond ONLY with valid JSON. "
                        "Normalize exercise names (e.g. 'flat bench' -> 'Flat Barbell Bench Press'). "
                        "If the user says '3 sets of 10 at 80kg', unpack it into 3 separate set objects. "
                        "For bodyweight or unweighted exercises, set weight_kg to 0. If reps are not specified, set reps to 0. "
                        "JSON format: {'exercises': [{'name': 'Exercise Name', 'sets': [{'set_number': 1, 'reps': 10, 'weight_kg': 80.0, 'rpe': 8}]}]}"
                    )
                },
                {"role": "user", "content": raw_text}
            ],
            temperature=0.7
        )
        
        response_text = completion.choices[0].message.content
        if response_text is None:
            raise HTTPException(status_code=422, detail="Ollama returned no content for the workout transcription")
        
        # Extract JSON from response
        try:
            payload = _extract_json_object(response_text)
            parsed_data = _sanitize_workout_payload(payload)
        except Exception as exc:
            raise ValueError(f"Could not parse valid workout JSON from Ollama: {response_text}") from exc

        # Step C: Write to PostgreSQL
        workout_record = Workout(raw_transcript=raw_text)
        db.add(workout_record)
        db.flush()

        for idx, ex_data in enumerate(parsed_data.exercises, start=1):
            exercise_record = Exercise(
                workout_id=workout_record.id,
                name=ex_data.name,
                exercise_order=idx
            )
            db.add(exercise_record)
            db.flush()

            for s in ex_data.sets:
                set_record = ExerciseSet(
                    exercise_id=exercise_record.id,
                    set_number=s.set_number,
                    reps=s.reps,
                    weight_kg=s.weight_kg,
                    rpe=s.rpe
                )
                db.add(set_record)

        db.commit()
        return {
            "status": "success",
            "workout_id": str(workout_record.id),
            "transcript": raw_text,
            "logged_at": workout_record.logged_at.isoformat() if getattr(workout_record, "logged_at", None) else None,
            "parsed": parsed_data.model_dump()
        }

    except Exception as exc:
        db.rollback()
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def _extract_json_object(text: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            return json.loads(match.group(0))
        raise


def _sanitize_workout_payload(payload: object) -> ExtractedWorkout:
    if not isinstance(payload, dict):
        raise ValueError("Ollama response did not contain a workout object")

    exercises = payload.get("exercises") or []
    cleaned_exercises = []

    for ex in exercises:
        if not isinstance(ex, dict):
            continue

        sets = ex.get("sets") or []
        cleaned_sets = []
        for index, s in enumerate(sets, start=1):
            if not isinstance(s, dict):
                continue

            reps = s.get("reps")
            weight = s.get("weight_kg")

            # Default None values to 0 so bodyweight and unweighted exercises pass
            cleaned_reps = 0 if reps is None else reps
            cleaned_weight = 0.0 if weight is None else weight

            try:
                cleaned_sets.append(
                    {
                        "set_number": int(s.get("set_number", index)),
                        "reps": int(cleaned_reps),
                        "weight_kg": float(cleaned_weight),
                        "rpe": s.get("rpe"),
                    }
                )
            except (TypeError, ValueError):
                continue

        if cleaned_sets:
            cleaned_exercises.append({
                "name": ex.get("name", "Unnamed Exercise"),
                "sets": cleaned_sets,
            })

    if not cleaned_exercises:
        raise ValueError("No valid exercise sets were returned by Ollama")

    return ExtractedWorkout(exercises=cleaned_exercises)