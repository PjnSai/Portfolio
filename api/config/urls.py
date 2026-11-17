from django.urls import include, path

from core.views import healthz

urlpatterns = [
    path("healthz", healthz),
    path("api/v1/admin/", include("core.admin_urls")),
    path("api/v1/", include("core.urls")),
]
