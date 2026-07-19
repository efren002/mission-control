export function PageLoading() {
  return (
    <div aria-busy="true" aria-label="Loading page" className="animate-page-in">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-3">
          <div className="skeleton h-2.5 w-24" />
          <div className="skeleton h-7 w-48 max-w-[70vw]" />
          <div className="skeleton h-3 w-72 max-w-[80vw]" />
        </div>
        <div className="skeleton h-9 w-28" />
      </div>

      <section className="control-panel mt-6 p-4 sm:p-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="space-y-4 border border-[#292824] bg-white/[0.015] p-4"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="skeleton h-3 w-28" />
                <div className="skeleton h-2 w-12" />
              </div>
              <div className="skeleton h-2.5 w-full" />
              <div className="skeleton h-2.5 w-3/4" />
            </div>
          ))}
        </div>
      </section>
      <span className="sr-only">Loading page content</span>
    </div>
  );
}
