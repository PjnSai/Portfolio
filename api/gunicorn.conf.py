import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
workers = 2
threads = 4
timeout = 30
graceful_timeout = 20
# Keeps the container usable with a read-only root filesystem.
worker_tmp_dir = "/dev/shm"
accesslog = "-"
errorlog = "-"
limit_request_line = 4094
limit_request_field_size = 8190
# No runtime management interface: one less thing listening.
control_socket_disable = True
