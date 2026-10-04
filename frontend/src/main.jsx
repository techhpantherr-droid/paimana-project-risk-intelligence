import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import Projects from "./pages/Projects";
import ProjectDetail from "./pages/ProjectDetail";
import Predict from "./pages/Predict";
import Risk from "./pages/Risk";
import Drivers from "./pages/Drivers";
import Benchmarks from "./pages/Benchmarks";
import Geography from "./pages/Geography";
import Models from "./pages/Models";
import DataGap from "./pages/DataGap";
import Assistant from "./pages/Assistant";
import Methodology from "./pages/Methodology";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "projects", element: <Projects /> },
      { path: "projects/:code", element: <ProjectDetail /> },
      { path: "predict", element: <Predict /> },
      { path: "risk", element: <Risk /> },
      { path: "drivers", element: <Drivers /> },
      { path: "benchmarks", element: <Benchmarks /> },
      { path: "sectors", element: <Geography /> },
      { path: "models", element: <Models /> },
      { path: "data-gap", element: <DataGap /> },
      { path: "assistant", element: <Assistant /> },
      { path: "methodology", element: <Methodology /> },
      { path: "*", element: <Dashboard /> },
    ],
  },
]);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);