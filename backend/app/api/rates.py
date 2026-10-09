"""Currency display rate (USD→INR) for showing rupees next to dollars."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..core import rates
from ..models import User
from ..security import current_user

router = APIRouter(prefix="/api", tags=["rates"])


@router.get("/rates")
def get_rates(user: User = Depends(current_user)):
    """`{base: "USD", rates: {INR: 96.9}, as_of, source, stale}`. `rates` is empty when no source has ever answered."""
    return rates.usd_inr()
