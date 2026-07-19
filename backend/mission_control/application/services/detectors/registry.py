from __future__ import annotations

from mission_control.application.services.detectors.base import Detector
from mission_control.application.services.detectors.dependency import (
    DependencyMaintenanceDetector,
)
from mission_control.application.services.detectors.documentation import (
    DocumentationDriftDetector,
)
from mission_control.application.services.detectors.failing_test import (
    FailingTestDiagnosisDetector,
)
from mission_control.application.services.detectors.issue_triage import (
    IssueTriageDetector,
)
from mission_control.application.services.detectors.mission_template import (
    MissionTemplateDetector,
)
from mission_control.application.services.detectors.repo_health import (
    RepoHealthDetector,
)
from mission_control.application.services.detectors.security import (
    SecurityHealthDetector,
)

_DETECTOR_CLASSES: tuple[type[Detector], ...] = (
    DependencyMaintenanceDetector,
    FailingTestDiagnosisDetector,
    DocumentationDriftDetector,
    IssueTriageDetector,
    SecurityHealthDetector,
    RepoHealthDetector,
    MissionTemplateDetector,
)

DETECTORS: dict[str, Detector] = {
    detector.kind: detector for detector in (cls() for cls in _DETECTOR_CLASSES)
}

DETECTOR_KINDS: tuple[str, ...] = tuple(DETECTORS)


def get_detector(kind: str) -> Detector:
    try:
        return DETECTORS[kind]
    except KeyError as error:
        raise ValueError(f"Unknown detector kind: {kind}") from error
