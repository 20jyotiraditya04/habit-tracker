from openai import OpenAI
import os

api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    print("ERROR: OPENAI_API_KEY not set")
    exit(1)

print(f"Using API key: {api_key[:20]}...")

client = OpenAI(api_key=api_key)

try:
    print("Creating audio file with TTS...")
    with client.audio.speech.with_streaming_response.create(
        model="tts-1",
        voice="alloy",
        input="I did three sets of ten reps on the bench press at eighty kilograms with RPE eight"
    ) as response:
        response.stream_to_file("sample.m4a")
    print("✅ Generated sample.m4a")
    print(f"File size: {os.path.getsize('sample.m4a')} bytes")
except Exception as e:
    print(f"❌ Error: {e}")
    import traceback
    traceback.print_exc()
