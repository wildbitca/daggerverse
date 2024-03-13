from dagger import dag, function, object_type


@object_type
class Debug:
    """Debug Artifact."""

    @function
    async def debug(self, message: str) -> str:
        """Debug the message."""

        return await dag.container().from_(address="alpine").with_exec(["echo", message]).stdout()
