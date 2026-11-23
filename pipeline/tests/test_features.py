from hyperscale_landscapes.providers.features import _status, classify, parse


def test_power_classification():
    assert classify({"power": "substation"}) == ("power", "substation")
    assert classify({"power": "line", "voltage": "275000"}) == ("power", "line")
    assert classify({"power": "generator", "generator:source": "wind"}) == ("power", "generator:wind")
    assert classify({"power": "plant", "plant:source": "solar"}) == ("power", "plant:solar")
    assert classify({"power": "plant", "plant:storage": "battery"}) == ("power", "battery")
    assert classify({"power": "construction", "construction": "substation"}) == ("power", "substation")


def test_status_is_read_from_tags_only():
    assert _status({"power": "substation"}) == "existing"
    assert _status({"power": "construction", "construction": "substation"}) == "construction"
    assert _status({"proposed:power": "substation"}) == "proposed"
    assert _status({"railway": "abandoned"}) == "disused"
    assert _status({"disused:railway": "rail"}) == "disused"


def test_residues_receptors_landcover():
    assert classify({"man_made": "spoil_heap"}) == ("residues", "man_made:spoil_heap")
    assert classify({"historic": "mine_shaft"}) == ("residues", "historic:mine_shaft")
    assert classify({"landuse": "quarry"}) == ("residues", "landuse:quarry")
    assert classify({"amenity": "school"}) == ("receptors", "school")
    assert classify({"social_facility": "nursing_home"})[0] == "receptors"
    assert classify({"landuse": "farmland"}) == ("landcover", "landuse:farmland")
    assert classify({"building": "house"}) is None


def test_names_only_for_institutions_and_no_private_tags():
    osm = {"elements": [
        {"type": "node", "id": 1, "lat": 56.1, "lon": -3.2,
         "tags": {"amenity": "school", "name": "Auchtertool Primary",
                  "addr:street": "Main St", "phone": "0123"}},
        {"type": "way", "id": 2, "tags": {"landuse": "residential", "name": "Some Estate"},
         "geometry": [{"lat": 56.1, "lon": -3.2}, {"lat": 56.1, "lon": -3.19},
                      {"lat": 56.11, "lon": -3.19}, {"lat": 56.1, "lon": -3.2}]},
    ]}
    feats = parse(osm)
    school = next(f for f in feats if f["layer"] == "receptors")
    assert school["tags"].get("name") == "Auchtertool Primary"
    assert "addr:street" not in school["tags"] and "phone" not in school["tags"]
    landcover = next(f for f in feats if f["layer"] == "landcover")
    assert "name" not in landcover["tags"]
    assert landcover["geometry"]["type"] == "Polygon"


def test_power_line_closed_way_stays_a_line():
    osm = {"elements": [{"type": "way", "id": 3, "tags": {"power": "line"},
                         "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1},
                                      {"lat": 1, "lon": 1}, {"lat": 0, "lon": 0}]}]}
    assert parse(osm)[0]["geometry"]["type"] == "LineString"
