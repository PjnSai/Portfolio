from django.urls import include, path

from core.views import healthz

urlpatterns = [
    path("healthz", healthz),
    path("api/v1/", include("core.urls")),
]
