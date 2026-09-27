"""Collections: resources, units, routines and payments.

Route handlers only — every rule lives in services/collections.py.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.models.collection import (
    CollectionSettings,
    PaymentCreate,
    ResourceCreate,
    ResourceUpdate,
    RoutineCreate,
    RoutineUpdate,
    SettleRequest,
)
from app.services import collections as service
from app.services.auth import get_current_user, get_current_user_with_tier

router = APIRouter(prefix="/collections", tags=["collections"])


def _refuse(exc: service.CollectionError) -> HTTPException:
    """The service's refusal as a structured error the client can show."""
    return HTTPException(
        status_code=exc.status,
        detail={"message": str(exc), "error_code": exc.code},
    )


# Resources, routines, occurrences and payments are declared before the
# /{cluster_id} routes: FastAPI matches in registration order, and a static
# segment registered later would be swallowed by the parameterised one.

# ---------------------------------------------------------------------------
# Resources and units
# ---------------------------------------------------------------------------

@router.post("/resources", status_code=status.HTTP_201_CREATED)
async def create_resource(body: ResourceCreate, auth: dict = Depends(get_current_user_with_tier)):
    try:
        return await service.create_resource(auth["user_id"], auth["tier"], body)
    except service.CollectionError as exc:
        raise _refuse(exc)


@router.get("/resources/{resource_id}")
async def get_resource(resource_id: UUID, user_id: UUID = Depends(get_current_user)):
    try:
        return await service.resource_view(resource_id, user_id)
    except service.CollectionError as exc:
        raise _refuse(exc)


@router.patch("/resources/{resource_id}")
async def update_resource(resource_id: UUID, body: ResourceUpdate,
                          user_id: UUID = Depends(get_current_user)):
    try:
        return await service.update_resource(resource_id, user_id, body)
    except service.CollectionError as exc:
        raise _refuse(exc)


@router.delete("/resources/{resource_id}", status_code=status.HTTP_204_NO_CONTENT)
async def archive_resource(resource_id: UUID, user_id: UUID = Depends(get_current_user)):
    try:
        await service.archive_resource(resource_id, user_id)
    except service.CollectionError as exc:
        raise _refuse(exc)


# ---------------------------------------------------------------------------
# Routines
# ---------------------------------------------------------------------------

@router.post("/routines", status_code=status.HTTP_201_CREATED)
async def create_routine(body: RoutineCreate, user_id: UUID = Depends(get_current_user)):
    try:
        routine = await service.create_routine(user_id, body)
        return await service.routine_view(UUID(str(routine["id"])), user_id)
    except service.CollectionError as exc:
        raise _refuse(exc)


@router.get("/routines/{routine_id}")
async def get_routine(routine_id: UUID, user_id: UUID = Depends(get_current_user)):
    try:
        return await service.routine_view(routine_id, user_id)
    except service.CollectionError as exc:
        raise _refuse(exc)


@router.patch("/routines/{routine_id}")
async def update_routine(routine_id: UUID, body: RoutineUpdate,
                         user_id: UUID = Depends(get_current_user)):
    try:
        await service.update_routine(routine_id, user_id, body)
        return await service.routine_view(routine_id, user_id)
    except service.CollectionError as exc:
        raise _refuse(exc)


@router.delete("/routines/{routine_id}", status_code=status.HTTP_204_NO_CONTENT)
async def archive_routine(routine_id: UUID, user_id: UUID = Depends(get_current_user)):
    try:
        await service.archive_routine(routine_id, user_id)
    except service.CollectionError as exc:
        raise _refuse(exc)


# ---------------------------------------------------------------------------
# Periods and payments
# ---------------------------------------------------------------------------

@router.post("/occurrences/{occurrence_id}/payments", status_code=status.HTTP_201_CREATED)
async def record_payment(occurrence_id: UUID, body: PaymentCreate,
                         user_id: UUID = Depends(get_current_user)):
    try:
        return await service.record_payment(occurrence_id, user_id, body)
    except service.CollectionError as exc:
        raise _refuse(exc)


@router.post("/occurrences/{occurrence_id}/settle")
async def settle(occurrence_id: UUID, body: SettleRequest | None = None,
                 user_id: UUID = Depends(get_current_user)):
    try:
        return await service.settle(occurrence_id, user_id, body.method if body else None)
    except service.CollectionError as exc:
        raise _refuse(exc)


@router.delete("/payments/{payment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_payment(payment_id: UUID, user_id: UUID = Depends(get_current_user)):
    try:
        await service.delete_payment(payment_id, user_id)
    except service.CollectionError as exc:
        raise _refuse(exc)


# ---------------------------------------------------------------------------
# The collection itself
# ---------------------------------------------------------------------------

@router.get("/{cluster_id}")
async def get_collection(cluster_id: UUID, user_id: UUID = Depends(get_current_user)):
    try:
        return await service.collection_view(cluster_id, user_id)
    except service.CollectionError as exc:
        raise _refuse(exc)


@router.put("/{cluster_id}/settings")
async def set_collection(cluster_id: UUID, body: CollectionSettings,
                         user_id: UUID = Depends(get_current_user)):
    try:
        return await service.set_collection(cluster_id, user_id, body.is_collection, body.collection_noun)
    except service.CollectionError as exc:
        raise _refuse(exc)
