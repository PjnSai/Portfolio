FROM python:3.12-slim-bookworm AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /venv
COPY requirements.txt .
RUN /venv/bin/pip install --require-hashes -r requirements.txt

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/venv/bin:$PATH
WORKDIR /app
COPY --from=build /venv /venv
COPY manage.py gunicorn.conf.py ./
COPY config ./config
COPY core ./core
# Media in local development only; production uses Cloud Storage.
RUN mkdir /media && chown 10001:10001 /media
USER 10001:10001
EXPOSE 8000
CMD ["gunicorn", "-c", "gunicorn.conf.py", "config.wsgi:application"]
