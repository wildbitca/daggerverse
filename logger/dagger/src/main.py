from dagger import dag, function, object_type


@object_type
class Logger:
    """Logger Artifact."""

    @function
    async def log(self, message: str) -> str:
        """Debug the message."""

        return await dag.container().from_(address="alpine").with_exec(["echo", message]).stdout()
