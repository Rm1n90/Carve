class AppError(Exception):
    """Base for application-level errors with an HTTP-friendly code."""

    http_status: int = 400
    code: str = "app_error"

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.code)
        self.message = message or self.code
