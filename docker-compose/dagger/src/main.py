from collections.abc import Sequence
from dataclasses import field

import yaml

from dagger import dag, function, object_type, File, Directory, Container, CacheVolume, Service


@object_type
class PreBuildContainer:
    """Pre-Build Container Artifact."""

    tag: str
    """Tag to use for the service."""

    container: Container
    """Container to use for the service."""


@object_type
class ProjectService:
    """Project Service Artifact."""

    name: str
    """Name of the service."""

    specs: dict[str, dict]
    """Specs of the service."""

    service: Service
    """Service to use."""


@object_type
class Project:
    """Project Artifact."""

    name: str
    """Name of the project."""

    base_dir: Directory
    """Name of the secret."""

    compose_file: File | None = None
    """Compose file to use."""

    env_file: File | None = None
    """Env file to use."""

    pre_build_containers: Sequence[PreBuildContainer] = field(default_factory=list)
    """Pre-build containers to use."""

    specs: dict[str, dict] | None = None
    """Specs of the project."""

    volumes: dict[str, CacheVolume] | None = None
    """Volumes of the project."""

    services: dict[str, ProjectService] | None = None
    """Services of the project."""

    def __post_init__(self):
        if not self.compose_file:
            self.compose_file = self.base_dir.file(path="docker-compose.yml")

    @function
    def add_pre_build_container(self, tag: str, container: Container) -> None:
        """Add a pre-build container."""

        self.pre_build_containers.append(PreBuildContainer(tag=tag, container=container))

    @function
    async def get_specs(self) -> dict[str, dict]:
        """Load the docker-compose file."""

        if not self.specs:
            ctr = (
                dag.container()
                .from_(address="alpine")
                .with_file(path="/usr/local/bin/docker-compose", source=dag.container().from_("docker/compose-bin").file("/docker-compose"))
                .with_workdir(path="/mnt")
            )

            await dag.logger().log(message=f"mounting docker-compose file {self.compose_file} inside container {await ctr.id()} as /mnt/docker-compose.yml")
            ctr = ctr.with_file(path="docker-compose.yml", source=self.compose_file)

            if self.env_file:
                await dag.logger().log(message=f"mounting .env file {self.env_file} inside container {await ctr.id()} as /mnt/.env")
                ctr = ctr.with_file(path=".env", source=self.env_file)

            ctr = (
                ctr
                .with_entrypoint(["docker-compose"])
                .with_exec(["config"])
            )

            specs = await ctr.stdout()

            await dag.logger().log(message=f"Loaded specs: {specs}")

            self.specs = yaml.safe_load(specs)

        return self.specs

    @function
    async def get_volumes(self) -> dict[str, CacheVolume]:
        """Prepare the volumes."""

        if not self.volumes:
            self.volumes = {}
            await dag.logger().log(message=f"Processing ({len(self.specs['volumes'])}) volumes from specs: {self.specs['volumes'].keys()}")
            for volume_name in self.specs["volumes"].keys():
                await dag.logger().log(message=f"Processing volume {volume_name}")
                self.volumes[volume_name] = dag.cache_volume(volume_name)

        return self.volumes

    @function
    async def __get_service(self, service_name: str, specs: dict[str, dict]) -> ProjectService:
        """Prepare the service."""

        container = None

        await dag.logger().log(message=f"Processing service {service_name}")
        await dag.logger().log(message=f"Specs for service {service_name}: {specs}")

        for pre_build_container in self.pre_build_containers:
            if pre_build_container.tag == service_name:
                container = pre_build_container.container
                await dag.logger().log(message=f"Picking container {await container.id()} for service {service_name}")

        if not container:
            await dag.logger().log(message=f"Creating container for service {service_name}")
            container = dag.container().from_(address=specs["image"])

        if "environment" in specs:
            for env_var, value in specs["environment"].items():
                await dag.logger().log(message=f"Setting environment variable {env_var} for service {service_name}")
                container = container.with_env_variable(name=env_var, value=value)

        if "labels" in specs:
            for label, value in specs["labels"].items():
                await dag.logger().log(message=f"Setting label {label} for service {service_name}")
                container = container.with_label(name=label, value=value)

        if "entrypoint" in specs:
            await dag.logger().log(message=f"Setting entrypoints for service {service_name}")
            for entrypoint in specs["entrypoint"]:
                await dag.logger().log(message=f"Setting entrypoint {entrypoint} for service {service_name}")
                container = container.with_entrypoint([entrypoint])

        if "command" in specs:
            await dag.logger().log(message=f"Setting commands for service {service_name}")
            for cmd in specs["command"]:
                await dag.logger().log(message=f"Setting command {cmd} for service {service_name}")
                container = container.with_exec([cmd])

        if "ports" in specs:
            for port in specs["ports"]:
                await dag.logger().log(message=f"Exposing port {port} for service {service_name}")
                container = container.with_exposed_port(port)

        if "volumes" in specs:
            for volume in specs["volumes"]:
                await dag.logger().log(message=f"Mounting volume {volume} for service {service_name}")
                source = volume["source"]
                target = volume["target"]
                if source in self.volumes:
                    await dag.logger().log(message=f"Mounting cache volume {source} for service {service_name} at {target}")
                    container = container.with_mounted_cache(path=target, cache=self.volumes[source])
                else:
                    await dag.logger().log(message=f"Mounting directory {source} for service {service_name} at {target}")
                    container = container.with_mounted_directory(path=target, source=self.base_dir.directory(path=source))

        return ProjectService(name=service_name, specs=specs, service=container.as_service())

    @function
    async def get_services(self) -> dict[str, ProjectService]:
        """Prepare the services."""

        if not self.services:
            self.services = {}
            await dag.logger().log(message=f"Processing ({len(self.specs['services'])}) services from specs: {self.specs['services'].keys()}")
            for service_name, specs in self.specs["services"].items():
                self.services[service_name] = await self.__get_service(service_name=service_name, specs=specs)

        return self.services

    @function
    async def up(self) -> None:
        """Run the docker compose up command."""

        await self.get_specs()
        await self.get_volumes()
        await self.get_services()

        # for project_service in self.services.values():
        #     await project_service.service.up()

    @function
    def get_service(self, name: str) -> Service | None:
        """Get a service."""

        return self.services[name] if name in self.services else None


@object_type
class DockerCompose:
    """Docker Compose Artifact."""

    @function
    def project(self, name: str, base_dir: Directory, compose_file: File | None = None, env_file: File | None = None) -> Project:
        """Create a project."""

        return Project(name=name, base_dir=base_dir, compose_file=compose_file, env_file=env_file)
