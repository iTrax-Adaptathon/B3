from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import engine, Base
import models

from routers.flights import router as flight_router
from routers.gates import router as gate_router
from routers.crew import router as crew_router
from routers.baggage import router as baggage_router
from routers.dashboard import router as dashboard_router
from routers.alerts import router as alerts_router
from routers.decisions import router as decisions_router
from routers.metrics import router as metrics_router
from routers.timeline import router as timeline_router
from routers.scenario import router as scenario_router
from routers.report import router as report_router


Base.metadata.create_all(bind=engine)


app = FastAPI(
    title="AeroMind - Autonomous Airport Operations Control"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(flight_router)
app.include_router(gate_router)
app.include_router(crew_router)
app.include_router(baggage_router)
app.include_router(dashboard_router)
app.include_router(alerts_router)
app.include_router(decisions_router)
app.include_router(metrics_router)
app.include_router(timeline_router)
app.include_router(scenario_router)
app.include_router(report_router)


@app.get("/")
def home():
    return {
        "message": "AeroMind backend is running",
        "docs": "/docs"
    }


@app.get("/health")
def health_check():
    return {
        "status": "healthy"
    }
