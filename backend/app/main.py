"""FastAPI 入口：占位分割接口，后续可替换为真实分割模型。"""

from io import BytesIO

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, ImageFilter, ImageOps

app = FastAPI(title="Chat Segment API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/segment")
async def segment(file: UploadFile = File(...)) -> Response:
    """
    接收单张图片，返回与输入同尺寸的 PNG（当前为边缘检测占位，便于联调 UI）。
    """
    raw = await file.read()
    img = Image.open(BytesIO(raw)).convert("RGB")
    gray = ImageOps.grayscale(img)
    edges = gray.filter(ImageFilter.FIND_EDGES).convert("RGB")
    # 与原图简单叠加以便肉眼区分“分割图”
    blended = Image.blend(img, edges, alpha=0.45)
    buf = BytesIO()
    blended.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")
