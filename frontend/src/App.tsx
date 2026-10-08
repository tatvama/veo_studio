import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { GenerateProvider } from "./components/Generate";
import { Shell } from "./components/Shell";
import { ErrorBoundary } from "./components/shell/ErrorBoundary";
import { useMotionPref } from "./components/shell/theme";
import { PageSkeleton } from "./components/ui";
import { useAuthStatus } from "./lib/queries";
import Home from "./pages/Home";
import Login from "./pages/Login";

// Pages load on first visit, so the first screen (and public review links) stay light.
const ApprovalsPage = lazy(() => import("./pages/admin/Approvals"));
const AuditPage = lazy(() => import("./pages/admin/Audit"));
const CostsPage = lazy(() => import("./pages/admin/Costs"));
const SettingsPage = lazy(() => import("./pages/admin/Settings"));
const TeamPage = lazy(() => import("./pages/admin/Team"));
const BrandKitsPage = lazy(() => import("./pages/BrandKits"));
const LibraryPage = lazy(() => import("./pages/Library"));
const ModelHub = lazy(() => import("./pages/models/ModelHub"));
const ProjectLayout = lazy(() => import("./pages/project/ProjectLayout"));
const PublicReview = lazy(() => import("./pages/PublicReview"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const KitGallery = import.meta.env.DEV ? lazy(() => import("./pages/dev/Kit")) : null;

/** Shown while a page's code downloads: a skeleton shaped like a page, after a short grace period so quick loads don't flash. */
export function PageLoading() {
  return (
    <motion.div className="h-full overflow-hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15, duration: 0.25 }}>
      <PageSkeleton />
    </motion.div>
  );
}

export default function App() {
  const motionPref = useMotionPref();
  return (
    <MotionConfig reducedMotion={motionPref === "reduced" ? "always" : "user"}>
      <AppRoutes />
    </MotionConfig>
  );
}

function AppRoutes() {
  const qc = useQueryClient();
  const loc = useLocation();
  const isPublicReview = loc.pathname.startsWith("/review/");
  const { data, isLoading } = useAuthStatus();

  useEffect(() => {
    const h = () => qc.invalidateQueries({ queryKey: ["auth"] });
    window.addEventListener("veo:unauthorized", h);
    return () => window.removeEventListener("veo:unauthorized", h);
  }, [qc]);

  // Client review links work without an account.
  if (isPublicReview) {
    return (
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/review/:token" element={<PublicReview />} />
        </Routes>
      </Suspense>
    );
  }

  if (isLoading || !data) {
    return <PageLoading />;
  }
  if (!data.user) return <Login setupNeeded={data.setup_needed} googleEnabled={data.google_enabled} />;

  // Animate between top-level sections only: keyed by the first path segment (plus the project id for /p/:pid),
  // so switching tabs inside a project never remounts ProjectLayout — it animates its own tab content instead.
  // Including the id keeps each exiting ProjectLayout's nested <Routes location> consistent with its parent match.
  const [, seg, sub] = loc.pathname.split("/");
  const section = seg === "p" ? `p/${sub}` : seg || "home";

  return (
    <GenerateProvider>
      <Shell user={data.user}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={section}
            className="h-full"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.17, ease: [0.22, 1, 0.36, 1] }}
          >
            <ErrorBoundary resetKey={loc.pathname}>
            <Suspense fallback={<PageLoading />}>
            <Routes location={loc}>
              <Route path="/" element={<Home />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/models" element={<ModelHub />} />
              <Route path="/brand-kits" element={<BrandKitsPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/approvals" element={<ApprovalsPage />} />
              <Route path="/costs" element={<CostsPage />} />
              <Route path="/team" element={<TeamPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/p/:pid/*" element={<ProjectLayout />} />
              {KitGallery && <Route path="/dev/kit" element={<KitGallery />} />}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
            </ErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </Shell>
    </GenerateProvider>
  );
}
