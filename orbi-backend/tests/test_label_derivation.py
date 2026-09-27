"""Bubble labels keep the action: "Visitar imóvel", not "Imóvel"."""

import pytest

from app.services.task_sanitizer import derive_label_from_title


@pytest.mark.parametrize(
    "title,expected",
    [
        ("Visitar um imóvel em São Domingos de Rana", "Visitar imóvel"),
        ("Visitar imóvel", "Visitar imóvel"),
        ("Ligar à minha mãe sobre o jantar", "Ligar mãe"),
        ("Call Mercedes about the warranty", "Call Mercedes"),
        ("Pagar a renda do apartamento", "Pagar renda"),
        ("Buy milk", "Buy milk"),
    ],
)
def test_the_label_keeps_the_verb_and_its_object(title, expected):
    label = derive_label_from_title(title)
    assert label == expected
    assert len(label) <= 20


def test_a_single_long_word_is_cut_not_lost():
    assert derive_label_from_title("Supercalifragilisticexpialidocious") == "Supercalifragilistic"
