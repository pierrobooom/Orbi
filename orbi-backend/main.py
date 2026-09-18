import asyncio
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv

# load_dotenv must run before any app module is imported so that
# os.environ is populated before client.py reads SUPABASE_URL etc.
load_dotenv()

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from app.routers import (  # noqa: E402
    tasks,
    finance,
    users,
    clusters,
    memory,
    chat,
    voice,
    notifications,
)
from app.services.reminder_dispatcher import run_forever  # noqa: E402

# The in-process reminder loop is the right answer for one instance and the
# wrong one for several — every replica would send every reminder. Set this
# to "0" and drive POST /notifications/dispatch from a single external cron
# instead. Defaults to on, because the alternative default is a feature that
# silently never fires.
_RUN_DISPATCHER = os.environ.get("RUN_REMINDER_DISPATCHER", "1") != "0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Orbi API is running")

    dispatcher: asyncio.Task | None = None
    if _RUN_DISPATCHER:
        dispatcher = asyncio.create_task(run_forever())

    yield

    if dispatcher is not None:
        # Cancel and await: without the await, shutdown races the loop and
        # a tick mid-send is torn down with its HTTP call half-finished.
        dispatcher.cancel()
        try:
            await dispatcher
        except asyncio.CancelledError:
            pass

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
app.include_router(notifications.router, prefix="/api/v1")


@app.get("/health")
async def health():
    return {"status": "ok", "app": "Orbi"}
