class Recorder:
    sent: list = []

    def send(self, event, context):
        self.sent.append((event, context))


class Broken:
    def send(self, event, context):
        raise ConnectionError("notifier is down")
