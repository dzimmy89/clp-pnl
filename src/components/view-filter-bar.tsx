"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NO_FILTER, TYPE_LABEL, type filterOptions, type ViewFilter } from "@/lib/view-filter";

const ALL = "__all";

/** Chain, app and position-type pickers above the book. Hidden when there is nothing to narrow. */
export function ViewFilterBar({
  filter,
  options,
  onChange,
}: {
  filter: ViewFilter;
  options: ReturnType<typeof filterOptions>;
  onChange: (filter: ViewFilter) => void;
}) {
  if (options.chains.length < 2 && options.apps.length < 2 && options.types.length < 2) return null;
  const active = filter.chain || filter.app || filter.type;
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter the book">
      <Picker
        label="Chain"
        all="All chains"
        value={filter.chain}
        choices={options.chains.map((chain) => ({ value: chain, label: chain }))}
        onChange={(chain) => onChange({ ...filter, chain })}
      />
      <Picker
        label="App"
        all="All apps"
        value={filter.app}
        choices={options.apps.map((app) => ({ value: app, label: app }))}
        onChange={(app) => onChange({ ...filter, app })}
      />
      <Picker
        label="Type"
        all="All types"
        value={filter.type}
        choices={options.types.map((type) => ({ value: type, label: TYPE_LABEL[type] }))}
        onChange={(type) => onChange({ ...filter, type: type as ViewFilter["type"] })}
      />
      {active ? (
        <button type="button" className="min-h-7 px-2 text-xs text-azure hover:underline" onClick={() => onChange(NO_FILTER)}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function Picker({
  label,
  all,
  value,
  choices,
  onChange,
}: {
  label: string;
  all: string;
  value: string | null;
  choices: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  const labelOf = (selected: unknown) =>
    selected === ALL || selected == null ? all : (choices.find((choice) => choice.value === selected)?.label ?? String(selected));
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next && next !== ALL ? String(next) : null)}>
      <SelectTrigger size="sm" aria-label={label} className={value ? "border-azure/60 text-azure" : undefined}>
        <SelectValue>{labelOf}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
