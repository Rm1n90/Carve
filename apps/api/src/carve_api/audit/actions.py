# Armin Mehri — mehri.armin@gmail.com
"""Canonical audit action strings (Plan-13 Phase 7 Task 3).

Centralising these constants keeps producers (review / retrain / export
/ task code) and consumers (audit list endpoint, frontend filter
dropdown) in lockstep. Changing the wire format requires touching
exactly one file.
"""

ANNOTATION_ACCEPTED: str = "annotation.accepted"
ANNOTATION_REJECTED: str = "annotation.rejected"
ANNOTATIONS_BATCH_REVIEWED: str = "annotations.batch_reviewed"

RETRAIN_SUBMITTED: str = "retrain.submitted"
RETRAIN_CANCELLED: str = "retrain.cancelled"
RETRAIN_COMPLETED: str = "retrain.completed"
RETRAIN_FAILED: str = "retrain.failed"

EXPORT_SUBMITTED: str = "export.submitted"
EXPORT_COMPLETED: str = "export.completed"

TASK_DELETED: str = "task.deleted"
CLASS_DELETED: str = "class.deleted"

PROJECT_MEMBER_ADDED: str = "project_member.added"
PROJECT_MEMBER_REMOVED: str = "project_member.removed"
PROJECT_MEMBER_ROLE_CHANGED: str = "project_member.role_changed"
