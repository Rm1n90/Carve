from fastapi.testclient import TestClient

from carve_api.main import create_app


def test_health_endpoint_returns_ok():
    app = create_app()
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
