export default function MissionControlTemplate({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <div className="animate-page-in">{children}</div>;
}
