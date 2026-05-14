def test_module_exposes_manager_singleton():
    from carve_model.sam.lifecycle import manager, SamLifecycleManager
    assert isinstance(manager, SamLifecycleManager)


def test_manager_is_consistent_across_imports():
    from carve_model.sam.lifecycle import manager as a
    from carve_model.sam.lifecycle import manager as b
    assert a is b
