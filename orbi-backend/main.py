from contextlib import asynccontextmanager

from dotenv import load_dotenv

# load_dotenv must run before any app module is imported so that
# os.environ is populated before client.py reads SUPABASE_URL etc.
load_dotenv()

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from app.routers import tasks, finance, users, clusters, memory, chat, voice  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Orbi API is running")
    yield
    print("Orbi API is shutting down")


app = FastAPI(
    title="Orbi API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: restrict to known origins before production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tasks.router, prefix="/api/v1")
app.include_router(finance.router, prefix="/api/v1")
app.include_router(users.router, prefix="/api/v1")
app.include_router(clusters.router, prefix="/api/v1")
app.include_router(memory.router, prefix="/api/v1")
app.include_router(chat.router, prefix="/api/v1")
app.include_router(voice.router, prefix="/api/v1")


@app.get("/health")
async def health():
    return {"status": "ok", "app": "Orbi"}
