import io

from app.services.media import audio_is_browser_ok, is_video


def upload(client, url, name, content=b"x", mime="application/octet-stream"):
    return client.post(url, files={"file": (name, io.BytesIO(content), mime)})


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def test_is_video_by_extension():
    assert is_video("clip.mp4")
    assert is_video("영상.MOV")
    assert is_video("a.mkv")
    assert not is_video("doc.pdf")
    assert not is_video("note.txt")
    assert not is_video("noext")


def test_audio_browser_ok_classification():
    # 브라우저가 그대로 재생 가능 → 재인코딩 불필요
    for ok in ("aac", "mp3", "opus", "vorbis", "flac", ""):
        assert audio_is_browser_ok(ok)
    # 브라우저 비호환 → AAC 변환 필요
    for bad in ("ac3", "eac3", "dts", "truehd", "pcm_s16le"):
        assert not audio_is_browser_ok(bad)


def test_video_preview_rejects_non_video(admin_client):
    pid = spaces_of(admin_client)["personal"]["id"]
    node = upload(
        admin_client, f"/api/spaces/{pid}/files", "문서.txt", b"hello", "text/plain"
    ).json()
    assert admin_client.get(f"/api/files/{node['id']}/preview.mp4").status_code == 400


def test_video_preview_serves_original_when_not_transcodable(admin_client):
    """ffmpeg/ffprobe가 없거나 프로브 실패(가짜 영상)여도 원본이라도 내려준다(그림은 나옴)."""
    pid = spaces_of(admin_client)["personal"]["id"]
    body = b"\x00\x00\x00\x18ftypmp42fake-video-bytes"
    node = upload(admin_client, f"/api/spaces/{pid}/files", "clip.mp4", body, "video/mp4").json()
    r = admin_client.get(f"/api/files/{node['id']}/preview.mp4")
    assert r.status_code == 200
    assert r.content == body
