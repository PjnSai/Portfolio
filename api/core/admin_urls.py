"""Every URL under /api/v1/admin/. Each view must be wrapped with admin_route."""

from django.urls import path

from core import admin_views as views

urlpatterns = [
    path("csrf", views.csrf),
    path("login/options", views.login_options),
    path("login/verify", views.login_verify),
    path("bootstrap/options", views.bootstrap_options),
    path("bootstrap/verify", views.bootstrap_verify),
    path("session", views.session),
    path("logout", views.logout),
    path("recovery/options", views.recovery_options),
    path("recovery/verify", views.recovery_verify),
    path("sessions/revoke-all", views.revoke_all),
    path("access/revoke-all", views.access_revoke_all),
    path("passkeys", views.passkey_list),
    path("elevate/options", views.elevate_options),
    path("elevate/verify", views.elevate_verify),
    path("audit", views.audit_list),
    path("audit/verify", views.audit_verify),
    path("vital-actions", views.vital_list),
    path("vital-actions/request", views.vital_request),
    path(
        "vital-actions/<uuid:action_id>/cancel",
        views.vital_cancel,
        name="vital-action-cancel",
    ),
    path("vital-actions/<uuid:action_id>/passkey-options", views.vital_passkey_options),
    path("vital-actions/<uuid:action_id>/execute", views.vital_execute),
]
