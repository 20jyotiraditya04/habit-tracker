from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel, field_validator
from pydantic import Field




class ExerciseStats(BaseModel):
    exercise_name: str
    total_volume_kg: float
    total_reps: int
    best_estimated_1rm: float

class WorkoutSummary(BaseModel):
    workout_id: str
    logged_at: datetime
    total_workout_volume: float
    exercises: List[ExerciseStats]

class WeeklyVolumeComparison(BaseModel):
    exercise_name: str
    current_week_volume: float
    previous_week_volume: float
    volume_change_percentage: Optional[float]
    current_week_best_1rm: float
    previous_week_best_1rm: float
    e1rm_change_percentage: Optional[float]

class SetBase(BaseModel):
    set_number: int
    reps: Optional[int]=0
    weight_kg: Optional[float]=0.0
    rpe: Optional[float]=None

    @field_validator("weight_kg", mode="before")
    def coerce_none_weight(cls, v):
        return 0.0 if v is None else v

    @field_validator("reps", mode="before")
    def coerce_none_reps(cls, v):
        return 0 if v is None else v

class ExerciseBase(BaseModel):
    name:str
    sets: list[SetBase]

class WorkoutParsed(BaseModel):
    exercises: list[ExerciseBase]



class SetUpdate(BaseModel):
    """ Fields that can be updated for an existing exercise set."""
    reps:Optional[int]=Field(default=None, ge=0)
    weight_kg:Optional[float]=Field(default=None, ge=0)
    rpe:Optional[float]=Field(default=None, ge=1, le=10)