import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

export function ArchivedToggle() {
  const [searchParams, setSearchParams] = useSearchParams();
  const showArchived = searchParams.get("showArchived") === "true";
  // Keep the checkbox responsive while React Router commits the URL change.
  const [isChecked, setIsChecked] = useState(showArchived);

  useEffect(() => {
    setIsChecked(showArchived);
  }, [showArchived]);

  return (
    <label className="subnav__archive-toggle">
      <input
        checked={isChecked}
        onChange={(event) => {
          const checked = event.target.checked;
          setIsChecked(checked);

          const nextParams = new URLSearchParams(searchParams);
          if (checked) {
            nextParams.set("showArchived", "true");
          } else {
            nextParams.delete("showArchived");
          }
          setSearchParams(nextParams, { replace: true });
        }}
        title="Show archived boards"
        type="checkbox"
      />
      <span>Archived</span>
    </label>
  );
}
