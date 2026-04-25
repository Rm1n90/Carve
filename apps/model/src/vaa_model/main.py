from fastapi import FastAPI


def create_app() -> FastAPI:
    app = FastAPI(title="VisualAutoAnnotator Model Service", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/capabilities")
    def capabilities() -> dict[str, list[str]]:
        # Plan 05 will populate this with actual models loaded in VRAM.
        return {"models": []}

    return app


app = create_app()
