export const TOUR_STORAGE_KEY = "mission-control.onboarding.tour";
export const CHECKLIST_STORAGE_KEY = "mission-control.onboarding.checklist";
export const OPEN_TOUR_EVENT = "mission-control.onboarding.open-tour";

export function isTourCompleted(): boolean {
  return window.localStorage.getItem(TOUR_STORAGE_KEY) === "done";
}

export function markTourCompleted() {
  window.localStorage.setItem(TOUR_STORAGE_KEY, "done");
}

export function isChecklistDismissed(): boolean {
  return window.localStorage.getItem(CHECKLIST_STORAGE_KEY) === "dismissed";
}

export function dismissChecklist() {
  window.localStorage.setItem(CHECKLIST_STORAGE_KEY, "dismissed");
}

export function openOnboardingTour() {
  window.dispatchEvent(new CustomEvent(OPEN_TOUR_EVENT));
}
