from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.llm import presets as presets_mod
from app.llm_keys_store import load_all, merge_into_stored

router = APIRouter(prefix="/api/settings", tags=["settings"])


class LlmKeysUpdate(BaseModel):
    keys: dict[str, str] = Field(default_factory=dict, description="preset_id → api_key；空字符串表示清除该预设")


class LlmPresetUpdate(BaseModel):
    preset_id: str = Field(..., description="预设 id，对应 providers.yaml 中 id")
    label: str = ""
    base_url: str = ""
    model: str = ""
    api_key_env: str = ""


@router.get("/llm-keys")
def get_llm_keys():
    """返回已保存的 Key（仅建议本机使用；文件位于用户数据目录）。"""
    return {"keys": load_all()}


@router.put("/llm-keys")
def put_llm_keys(payload: LlmKeysUpdate):
    merged = merge_into_stored(payload.keys)
    return {"keys": merged}


@router.put("/llm-preset")
def put_llm_preset(payload: LlmPresetUpdate):
    """将当前预设的展示名、Base URL、模型、环境变量名写入用户数据目录 providers.yaml。"""
    pid = payload.preset_id.strip()
    if not pid:
        raise HTTPException(status_code=400, detail="preset_id 不能为空")
    try:
        presets_mod.update_user_preset(
            pid,
            label=payload.label,
            base_url=payload.base_url,
            model=payload.model,
            api_key_env=payload.api_key_env,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}
