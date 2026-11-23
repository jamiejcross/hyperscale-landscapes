from hyperscale_landscapes.geometry import labels


def test_fold_replaces_missing_glyphs():
    assert labels.fold("Height exaggerated ×2 – Lochgelly é") == "Height exaggerated x2 - Lochgelly e"
    assert labels.fold("© OSM · x") == "© OSM · x"


def test_text_polygon_size():
    g = labels.text_polygon("HHH", 4.0)
    h = g.bounds[3] - g.bounds[1]
    assert 3.8 < h < 4.4          # cap height plus the small stroke growth


def test_layout_fits_and_has_scale_bar():
    geom, rep = labels.layout([("Auchtertool", 6.0), ("Height exaggerated ×2", 3.6)],
                              150, 67, mm_per_m=0.04, width_m=3700)
    assert not rep.get("overflow")
    assert rep["scale_bar_m"] in (500, 1000)
    minx, miny, maxx, maxy = geom.bounds
    assert minx >= 0 and maxx <= 150 and miny >= 0 and maxy <= 67


def test_engrave_depth_is_below_overhang_threshold():
    from hyperscale_landscapes.geometry.checks import overhangs
    import trimesh
    geom, _ = labels.layout([("AB", 6.0)], 60, 40, mm_per_m=1.0, width_m=60)
    cutter = labels.engrave_cutter(geom, 1.0, base_bottom=0.0)
    assert cutter.bounds[1][2] <= labels.ENGRAVE_MM + 1e-9
    from hyperscale_landscapes.geometry.union import subtract
    slab = trimesh.creation.box(extents=(60, 40, 5)); slab.apply_translation((30, 20, 2.5))
    cut = subtract(slab, cutter)
    assert cut.is_watertight
    assert overhangs(cut)[0] == 0      # engraving ceilings sit under the 0.5 mm bed line
