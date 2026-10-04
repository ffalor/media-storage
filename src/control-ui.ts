import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import { MediaStorageApp, PAGE_ID } from "./ui/app.js";
import { Store } from "./ui/store.js";
import "./control-ui.css";

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    const disposePage = host.ui.registerPage({
      id: PAGE_ID,
      label: "Media Storage",
      mount(container, context) {
        // Typed feature operations only; no broad host.request calls.
        const store = new Store(createFeatureClient(contract, context.host));
        const stopUpdates = store.watchUpdates();
        const app = new MediaStorageApp(context.host, store, context.props);
        container.append(app.root);
        app.setPresented(context.presented);
        const dispose = () => {
          stopUpdates();
          store.dispose();
          app.dispose();
        };
        context.signal.addEventListener("abort", dispose, { once: true });
        return {
          update(next) {
            app.setPresented(next.presented);
            app.setParams(next.props);
          },
          focus: () => app.focus(),
          dispose,
        };
      },
    });
    const disposeNav = host.ui.registerNavigation({
      id: PAGE_ID,
      label: "Media Storage",
      page: { id: PAGE_ID },
      icon: "server",
    });
    return () => {
      disposeNav();
      disposePage();
    };
  },
});
