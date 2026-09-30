import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DataPage } from "./DataPage";
import "./styles/colors_and_type.css";
import "./styles/components.css";
import "./styles.css";
import "./data.css";

const Page = window.location.pathname.replace(/\/+$/, "") === "/data" ? DataPage : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>
);

