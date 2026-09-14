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


Base.metadata.create_all(bind=engine)


app = FastAPI(
    title="Autonomous Airport Operations Platform"
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

@app.get("/")
def home():
    return {
        "message": "Autonomous Airport Operations Platform Backend is running"
    }


@app.get("/health")
def health_check():
    return {
        "status": "healthy"
    }