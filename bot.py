"""VoiceCare: a voice receptionist that checks, books and cancels doctor appointments.

Pipeline (one per call):

    browser mic -> WebRTC in -> ElevenLabs STT -> user context -> Gemini (with tools)
                -> ElevenLabs TTS -> WebRTC out -> browser speaker

Run:  python bot.py   then open http://localhost:7860
"""

import os
import ssl
from datetime import datetime
from pathlib import Path

import aiohttp
import certifi

# Python from python.org on macOS ships without trusted certificates, which breaks
# HTTPS/WSS calls to ElevenLabs and Google. Point it at certifi's bundle.
os.environ.setdefault("SSL_CERT_FILE", certifi.where())

from dotenv import load_dotenv
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
from pipecat.runner.run import app
from pipecat.runner.types import RunnerArguments
from pipecat.services.elevenlabs.stt import CommitStrategy, ElevenLabsRealtimeSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsHttpTTSService, ElevenLabsTTSService
from pipecat.services.google.llm import GoogleLLMService
from pipecat.services.sarvam.llm import SarvamLLMService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.transcriptions.language import Language

import clinic

load_dotenv(override=True)
clinic.init_db()

FRONTEND = Path(__file__).parent / "frontend"

# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


def system_prompt() -> str:
    doctors = ", ".join(f"{d['name']} ({d['specialty']})" for d in clinic.dashboard_doctors())
    now = datetime.now().strftime("%A %d %B %Y, %I:%M %p")
    return f"""You are Maya, the voice receptionist of VoiceCare Clinic. Right now it is {now}.
Doctors: {doctors}. They see patients on weekdays.

You can check a doctor's free slots, book an appointment, and cancel an appointment.

Language:
- English is the default. Look at the caller's latest message: if it is in English, reply ONLY
  in English. Switch to Hindi or Bengali only when the caller actually speaks Hindi or Bengali,
  and switch back if they return to English. Callers may also mix (Hinglish): then mirror their mix.
- When replying in Hindi, Bengali or another Indian language, write in that language's own script
  (Hindi in Devanagari, Bengali in Bengali script), because the voice reads that script best.
  Doctor names can stay in English.
- Always pass tool arguments in English: doctor names or specialties in English
  ("cardiologist", "dermatologist", "pediatrician", "general physician"), dates as YYYY-MM-DD,
  and phone numbers as plain digits 0-9.
- When reading a phone number back in Hindi or Bengali, say the digits in that language one by one.
- In Hindi or Bengali replies, write every number, date and time as words in that language, never
  as digits, and never use "AM", "PM" or "Dr." (say morning/afternoon in that language, e.g.
  "সকাল দশটা", "सुबह साढ़े दस बजे", and use "ডাক্তার" / "डॉक्टर"). The voice reads words far more
  clearly than mixed digits and English abbreviations.
- Never correct yourself out loud or ask the caller to check a date you are unsure of. Read the date
  from the tool result once, correctly.

How to talk:
- This is a phone call. Keep every reply to one or two short sentences. No lists, markdown or emojis.
- Say times naturally, like "Wednesday at 10:30 AM". Offer at most three slots at a time.

Identifying the caller:
- The caller is identified ONLY by the phone number they say. There is no login or OTP.
- Before booking or cancelling, ask for their phone number, then read it back digit by digit
  (for example "nine eight seven six five, four three two one zero") and ask them to confirm.
- Callers often say a number in parts with pauses. If you hear only some digits, don't call it
  incomplete: say "go on" and join the parts. An Indian mobile number has 10 digits.
- Only call book_appointment or cancel_appointment after the caller has confirmed the number.
- Before booking, also ask for the caller's name and pass it as patient_name.

Tools:
- Always use check_doctor_availability before offering times. Never invent slots.
- As soon as the caller names a doctor, specialty or need, call check_doctor_availability in that
  same turn and offer real times. Never say "let me check" without calling the tool right away.
- Copy days, dates and times exactly from the tool result. When speaking another language,
  translate the words but never change the date number, weekday or time.
- When booking, pass starts_at exactly as returned by check_doctor_availability.
- To cancel: once the number is confirmed, call cancel_appointment with just the phone number
  straight away. Don't ask which appointment first. Only if the tool replies that the number has
  several appointments, read them out and ask which one, then call it again with appointment_id.
- If a tool returns ok=false, explain the problem simply and help them pick another option.
- After a successful booking or cancellation, confirm the doctor, day and time, then ask if there's anything else.

Never promise anything you can't do. You cannot send SMS, email or reminders, and you cannot give
medical advice. If asked, say so politely and suggest they note the time down or speak to the doctor.
"""


# ---------------------------------------------------------------------------
# Tools the LLM can call
# ---------------------------------------------------------------------------

TOOLS = ToolsSchema(
    standard_tools=[
        FunctionSchema(
            name="check_doctor_availability",
            description="Get free appointment slots. Filter by doctor name or specialty, and optionally a date.",
            properties={
                "doctor": {"type": "string", "description": "Doctor name or specialty, e.g. 'Mehta' or 'cardiologist'. Omit for all doctors."},
                "date": {"type": "string", "description": "Date as YYYY-MM-DD. Omit for the next available days."},
            },
            required=[],
        ),
        FunctionSchema(
            name="book_appointment",
            description="Book a free slot for the caller. Only call after the caller confirmed their phone number.",
            properties={
                "doctor": {"type": "string", "description": "The doctor's name."},
                "starts_at": {"type": "string", "description": "Slot start exactly as returned by check_doctor_availability, e.g. 2026-11-25T10:30."},
                "phone": {"type": "string", "description": "Caller's confirmed phone number, digits only."},
                "patient_name": {"type": "string", "description": "Caller's name, if they gave it."},
            },
            required=["doctor", "starts_at", "phone"],
        ),
        FunctionSchema(
            name="cancel_appointment",
            description="Cancel the caller's booked appointment, found by their confirmed phone number.",
            properties={
                "phone": {"type": "string", "description": "Caller's confirmed phone number, digits only."},
                "appointment_id": {"type": "integer", "description": "Which appointment to cancel, only needed if the number has several."},
            },
            required=["phone"],
        ),
    ]
)


async def notify_dashboard(params: FunctionCallParams, event: str, payload: dict) -> None:
    """Tell the browser something changed so the dashboard can refresh instantly."""
    await params.llm.push_frame(RTVIServerMessageFrame(data={"event": event, **payload}))


async def handle_check_availability(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"check_doctor_availability {dict(args)}")
    await params.result_callback(clinic.check_availability(args.get("doctor"), args.get("date")))


async def handle_book(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"book_appointment {dict(args)}")
    result = clinic.book_appointment(args["doctor"], args["starts_at"], args["phone"], args.get("patient_name"))
    if result["ok"]:
        await notify_dashboard(params, "booked", result)
    await params.result_callback(result)


async def handle_cancel(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"cancel_appointment {dict(args)}")
    result = clinic.cancel_appointment(args["phone"], args.get("appointment_id"))
    if result["ok"]:
        await notify_dashboard(params, "cancelled", result["cancelled"])
    await params.result_callback(result)


# ---------------------------------------------------------------------------
# The bot: one pipeline per browser call
# ---------------------------------------------------------------------------


def create_llm():
    """Pick the LLM from LLM_PROVIDER in .env: 'sarvam' (default) or 'google'."""
    provider = os.getenv("LLM_PROVIDER", "sarvam").lower()
    if provider == "google":
        return GoogleLLMService(
            api_key=os.environ["GOOGLE_API_KEY"],
            settings=GoogleLLMService.Settings(
                model=os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite"),
                system_instruction=system_prompt(),
            ),
            # Free-tier Gemini is sometimes slow under load: retry once instead of going silent.
            retry_timeout_secs=8.0,
            retry_on_timeout=True,
        )
    # Sarvam's OpenAI-compatible API. "-conversations" is its low-latency chat model.
    return SarvamLLMService(
        api_key=os.environ["SARVAM_API_KEY"],
        settings=SarvamLLMService.Settings(
            model=os.getenv("SARVAM_MODEL", "sarvam-105b-conversations"),
            system_instruction=system_prompt(),
        ),
    )


def create_tts(http_session: aiohttp.ClientSession):
    """Maya's voice. ELEVENLABS_TTS_MODEL picks the trade-off:

    - eleven_v3 (default): clearest Hindi/Bengali pronunciation, ~0.7 s to first audio, HTTP only.
    - eleven_flash_v2_5: fastest (~0.2 s to first audio), streams over WebSocket, fewer credits.
    """
    voice = os.getenv("ELEVENLABS_VOICE_ID", "hpp4J3VqNfWAUOO0d1Us")
    model = os.getenv("ELEVENLABS_TTS_MODEL", "eleven_v3")
    if model == "eleven_v3":
        return ElevenLabsHttpTTSService(
            api_key=os.environ["ELEVENLABS_API_KEY"],
            aiohttp_session=http_session,
            settings=ElevenLabsHttpTTSService.Settings(voice=voice, model=model),
        )
    return ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        settings=ElevenLabsTTSService.Settings(voice=voice, model=model),
    )


async def bot(runner_args: RunnerArguments):
    # aiohttp doesn't read SSL_CERT_FILE, so give it certifi's bundle explicitly.
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=ssl_context)) as http_session:
        await run_call(runner_args, http_session)


async def run_call(runner_args: RunnerArguments, http_session: aiohttp.ClientSession):
    transport = SmallWebRTCTransport(
        webrtc_connection=runner_args.webrtc_connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )

    stt = ElevenLabsRealtimeSTTService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        # ElevenLabs decides when the caller has finished a sentence, so the
        # transcript is finalized even if our local voice detector misses quiet speech.
        commit_strategy=CommitStrategy.VAD,
        settings=ElevenLabsRealtimeSTTService.Settings(
            vad_silence_threshold_secs=0.6,
            # English first, plus the regional languages in CALLER_LANGUAGES (default Hindi, Bengali).
            # A short explicit list stops the model guessing random languages for short
            # replies like "yes", which happened with full auto-detection.
            language=Language.EN,
            secondary_languages=[
                code.strip() for code in os.getenv("CALLER_LANGUAGES", "hi,bn").split(",") if code.strip()
            ],
            keyterms=[d["name"].replace("Dr. ", "") for d in clinic.dashboard_doctors()]
            + ["cardiologist", "dermatologist", "pediatrician", "appointment"],
            filter_background_audio=True,
        ),
    )
    tts = create_tts(http_session)
    llm = create_llm()

    llm.register_function("check_doctor_availability", handle_check_availability)
    llm.register_function("book_appointment", handle_book)
    llm.register_function("cancel_appointment", handle_cancel)

    context = LLMContext(tools=TOOLS)
    aggregators = LLMContextAggregatorPair(
        context,
        # Laptop mics are often quiet: the default min_volume (0.6) ignored normal speech.
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(confidence=0.5, min_volume=0.2))
        ),
    )

    pipeline = Pipeline([
        transport.input(),
        stt,
        aggregators.user(),
        llm,
        tts,
        transport.output(),
        aggregators.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Caller connected")
        context.add_message({"role": "user", "content": "(The call just connected. Greet the caller briefly in English, mention they can also speak Hindi or Bengali, and ask how you can help. After this, follow the caller's language.)"})
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Caller hung up")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=runner_args.handle_sigint)
    await runner.run(task)


# ---------------------------------------------------------------------------
# Dashboard routes (added to Pipecat's development server)
# ---------------------------------------------------------------------------


@app.get("/", include_in_schema=False)
async def dashboard():
    return FileResponse(FRONTEND / "index.html")


@app.get("/api/doctors")
async def api_doctors():
    return clinic.dashboard_doctors()


@app.get("/api/appointments")
async def api_appointments():
    return clinic.dashboard_appointments()


@app.post("/api/client-log", include_in_schema=False)
async def client_log(entry: dict):
    """Browser errors and call events, so problems show up in the server log."""
    logger.info(f"[browser] {entry}")
    return {"ok": True}


app.mount("/assets", StaticFiles(directory=FRONTEND), name="assets")


@app.middleware("http")
async def no_cache_dashboard(request, call_next):
    """Always serve the latest dashboard files while developing."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/assets"):
        response.headers["Cache-Control"] = "no-store"
    return response


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
