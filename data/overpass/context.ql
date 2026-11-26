[out:json][timeout:240];
(
  way["power"~"^(line|minor_line)$"]({{bbox}});
  node["power"~"^(tower|pole)$"]({{bbox}});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]({{bbox}});
  way["highway"="unclassified"]({{bbox}});
  way["railway"~"^(rail|disused)$"]({{bbox}});
  way["waterway"~"^(river|stream|canal)$"]({{bbox}});
  nwr["natural"="water"]({{bbox}});
  nwr["landuse"~"^(industrial|quarry|landfill)$"]({{bbox}});
  way["man_made"="pipeline"]({{bbox}});
  way["building"]({{bbox}});
  node["place"~"^(village|hamlet|town)$"]({{bbox}});
);
out tags geom({{bbox}});
