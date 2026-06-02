import { useNavigate } from "react-router-dom";
import PayPalReturnHandler from "./PayPalReturnHandler.jsx";

/** Browser-router bridge for PayPal full-page return (`/?token=ORDER_ID`). */
export default function PayPalReturnBridge() {
  const navigate = useNavigate();
  return (
    <PayPalReturnHandler
      navigate={(to) => {
        const raw = String(to || "/").trim();
        if (raw.startsWith("#")) {
          navigate(raw.slice(1) || "/");
          return;
        }
        navigate(raw.startsWith("/") ? raw : `/${raw}`);
      }}
    />
  );
}
