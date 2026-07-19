import { BackToTop } from "@/components/layout/back-to-top";
import { NavigationFeedback } from "@/components/layout/navigation-feedback";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { OnboardingTour } from "@/features/onboarding/onboarding-tour";

export default function MissionControlLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen">
      <NavigationFeedback />
      <Sidebar />
      <div className="min-w-0 flex-1">
        <Topbar />
        <main className="mx-auto w-full max-w-[1800px] overflow-x-hidden p-3 sm:p-4 md:p-6">{children}</main>
        <BackToTop />
      </div>
      <OnboardingTour />
    </div>
  );
}
