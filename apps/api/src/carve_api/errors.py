# Armin Mehri — mehri.armin@gmail.com
class AppError(Exception):
    """Base for application-level errors with an HTTP-friendly code."""

    http_status: int = 400
    code: str = "app_error"

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.code)
        self.message = message or self.code


class NotProjectMember(AppError):
    """Raised when an actor has no membership row on the target project.

    Plan-13 Phase 7 Task 2 — surfaces 403 from project-level mutating
    endpoints. For task-routed endpoints the visibility check in
    ``require_visible_task`` masks the same condition as 404 (TaskNotFound)
    to avoid leaking project existence (IDOR mitigation).
    """

    http_status = 403
    code = "not_project_member"


class InsufficientRole(AppError):
    """Raised when the actor is a project member but lacks the required role.

    Plan-13 Phase 7 Task 2 — viewers hitting mutating endpoints get this
    (403). Members/admins/owners on read endpoints never see it.
    """

    http_status = 403
    code = "insufficient_role"
