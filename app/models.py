import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Numeric, Text, DateTime, ForeignKey, CheckConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import declarative_base, relationship, Mapped, mapped_column

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

class Workout(Base):
    __tablename__ = "workouts"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    raw_transcript = Column(Text, nullable=False)
    logged_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    exercises = relationship("Exercise", back_populates="workout", cascade="all, delete-orphan")

class Exercise(Base):
    __tablename__ = "exercises"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    workout_id = Column(UUID(as_uuid=True), ForeignKey("workouts.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    exercise_order = Column(Integer, nullable=False)
    workout = relationship("Workout", back_populates="exercises")
    sets = relationship("ExerciseSet", back_populates="exercise", cascade="all, delete-orphan")

class ExerciseSet(Base):
    __tablename__ = "exercise_sets"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exercise_id = Column(UUID(as_uuid=True), ForeignKey("exercises.id", ondelete="CASCADE"), nullable=False)
    set_number : Mapped[int] = mapped_column(Integer, nullable=False)
    reps = Column(Integer, nullable=False)
    weight_kg = Column(Numeric(5, 2), default=0.0)
    rpe = Column(Integer, nullable=True)
    __table_args__ = (
        CheckConstraint("rpe >= 1 AND rpe <= 10", name="rpe_range_check"),
    )
    exercise = relationship("Exercise", back_populates="sets")