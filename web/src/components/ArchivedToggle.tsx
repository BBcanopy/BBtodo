import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { EyeIcon, EyeOffIcon } from "./ui";

export function ArchivedToggle() {
  const [searchParams, setSearchParams] = useSearchParams();
  const showArchived = searchParams.get("showArchived") === "true";
  // Keep the menu item responsive while React Router commits the URL change.
  const [isChecked, setIsChecked] = useState(showArchived);

  useEffect(() => {
    setIsChecked(showArchived);
  }, [showArchived]);

  return (
    <button
      aria-checked={isChecked}
      className="menu-item menu-item--with-icon"
      onClick={() => {
        const checked = !isChecked;
        setIsChecked(checked);

        const nextParams = new URLSearchParams(searchParams);
        if (checked) {
          nextParams.set("showArchived", "true");
        } else {
          nextParams.delete("showArchived");
        }
        setSearchParams(nextParams, { replace: true });
      }}
      role="menuitemcheckbox"
      title={isChecked ? "Hide archived boards" : "Show archived boards"}
      type="button"
    >
      {isChecked ? (
        <EyeIcon className="ui-icon archived-icon--shown" />
      ) : (
        <EyeOffIcon className="ui-icon archived-icon--hidden" />
      )}
      Archived
    </button>
  );
}
