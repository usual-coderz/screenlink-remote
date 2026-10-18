import os
import secrets
import time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from pydantic import BaseModel

app = FastAPI(title="ScreenLink Remote")

sessions = {}
SESSION_TTL = 300


class PairRequest(BaseModel):
    device_name: str


@app.get("/")
async def home():
    return {"app": "ScreenLink Remote", "status": "online"}


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/pair")
async def create_pair(request: PairRequest):
    device_name = request.device_name.strip()[:40]
    if not device_name:
        raise HTTPException(status_code=400, detail="Device name required")

    code = secrets.token_urlsafe(6)
    sessions[code] = {
        "device_name": device_name,
        "created": time.time()
    }

    return {
        "pair_code": code,
        "expires_in_seconds": SESSION_TTL
    }


@app.websocket("/ws/{pair_code}")
async def websocket_endpoint(websocket: WebSocket, pair_code: str):
    session = sessions.get(pair_code)

    if not session or time.time() - session["created"] > SESSION_TTL:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    try:
        while True:
            message = await websocket.receive_text()
            if len(message) > 65536:
                await websocket.close(code=1009)
                break
            await websocket.send_json({
                "type": "ack",
                "received": True
            })
    except WebSocketDisconnect:
        pass

5. **Commit changes** par tap karo.

### Is version mein kya hai?
- Backend health check.
- Temporary pairing code generation.
- WebSocket connection ka basic test.

**Dhyan do:** Yeh abhi sirf starter backend hai—live screen streaming ya remote touch control implement nahi karta. Pairing code bhi abhi production-grade authentication nahi hai, isliye ise real devices ke liye deploy mat karna.

### Agla step
File commit ho jaaye toh `Done` likhna. Phir hum Heroku deployment configuration aur GitHub Actions APK build workflow banayenge.